import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Component } from '../../architecture.js';
import { listRepositoryFiles } from '../../repository.js';
import type { ViewGraph } from '../view-graph.js';
import { callsExtractor } from './index.js';

const component = (id: string, paths: string[]): Component => ({
  id,
  name: id,
  type: 'service',
  tech: '',
  description: '',
  paths,
  entryPoint: '',
});

const CONTROLLER = `
import { Controller, Get } from '@nestjs/common';
import { OrdersService } from './orders.service.js';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list() {
    return this.orders.findAll();
  }
}
`;

const SERVICE = `
import { tableKey } from '../db/index.js';
import * as audit from '../audit.js';

export class OrdersService {
  findAll() {
    audit.record('list');
    return this.query(tableKey('orders'));
  }

  private query(key: string) {
    return [key];
  }
}
`;

const DB_BARREL = `export { tableKey } from './keys.js';\n`;
const DB_KEYS = `export const tableKey = (name: string) => \`TABLE#\${name}\`;\n`;
const AUDIT = `export function record(action: string) { console.log(action); }\n`;

const PAGE = `
import { useOrders } from '@/lib/orders';
import OrderRow from './order-row';

export function OrdersPage() {
  const orders = useOrders();
  return <ul>{orders.map((o) => <OrderRow key={o.id} order={o} onOpen={openOrder} />)}</ul>;
}

function openOrder() {}
`;

const ROW = `export default function OrderRow() { return <li />; }\n`;
const HOOK = `
import { listOrders } from './api';
export const useOrders = () => useQuery({ queryKey: ['orders'], queryFn: listOrders });
`;
const API = `export async function listOrders() { return fetch('/orders'); }\n`;

describe('callsExtractor', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'struct-calls-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const file = async (path: string, content: string) => {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  };

  const helpers = ({ nodes, edges }: ViewGraph) => ({
    node: (id: string) => nodes.find((n) => n.id === id),
    edge: (from: string, to: string) =>
      edges.find((e) => e.from === from && e.to === to),
  });

  it('resolves calls through imports, barrels, namespaces, and injected services', async () => {
    await file('api/src/orders/orders.controller.ts', CONTROLLER);
    await file('api/src/orders/orders.service.ts', SERVICE);
    await file('api/src/db/index.ts', DB_BARREL);
    await file('api/src/db/keys.ts', DB_KEYS);
    await file('api/src/audit.ts', AUDIT);
    await file('web/src/routes/orders.tsx', PAGE);
    await file('web/src/routes/order-row.tsx', ROW);
    await file('web/src/lib/orders.ts', HOOK);
    await file('web/src/lib/api.ts', API);
    await file(
      'web/src/lib/api.test.ts',
      "import { listOrders } from './api';\nlistOrders();",
    );

    const graph = await callsExtractor.extract({
      repoDir: dir,
      paths: await listRepositoryFiles(dir),
      components: [component('api', ['api']), component('web', ['web'])],
      facts: new Map(),
      llm: {
        callTool: () => Promise.reject(new Error('unexpected model call')),
      },
    });
    const { node, edge } = helpers(graph);
    const fn = (file: string, key: string) => `fn:${file}#${key}`;
    const controller = fn(
      'api/src/orders/orders.controller.ts',
      'OrdersController.list',
    );
    const findAll = fn(
      'api/src/orders/orders.service.ts',
      'OrdersService.findAll',
    );

    expect(node(controller)).toMatchObject({
      name: 'OrdersController.list()',
      kind: 'handler',
      group: 'api',
      componentId: 'api',
      detail: 'api/src/orders/orders.controller.ts:10',
    });
    // `this.orders.findAll()` through the constructor's `orders: OrdersService`.
    expect(edge(controller, findAll)).toMatchObject({ label: '' });
    // `this.query()` within the class.
    expect(
      edge(
        findAll,
        fn('api/src/orders/orders.service.ts', 'OrdersService.query'),
      ),
    ).toBeDefined();
    // Through the db barrel's re-export, and a namespace import.
    expect(edge(findAll, fn('api/src/db/keys.ts', 'tableKey'))).toBeDefined();
    expect(edge(findAll, fn('api/src/audit.ts', 'record'))).toBeDefined();

    const page = fn('web/src/routes/orders.tsx', 'OrdersPage');
    expect(node(page)).toMatchObject({
      name: '<OrdersPage>',
      kind: 'component',
    });
    // `@/` alias, a default-exported component, and a function passed as a prop.
    expect(edge(page, fn('web/src/lib/orders.ts', 'useOrders'))).toBeDefined();
    expect(
      edge(page, fn('web/src/routes/order-row.tsx', 'OrderRow')),
    ).toMatchObject({
      label: 'renders',
    });
    expect(
      edge(page, fn('web/src/routes/orders.tsx', 'openOrder')),
    ).toMatchObject({
      label: 'uses',
    });
    expect(
      edge(
        fn('web/src/lib/orders.ts', 'useOrders'),
        fn('web/src/lib/api.ts', 'listOrders'),
      ),
    ).toMatchObject({ label: 'uses' });
    // Tests are left out.
    expect(graph.nodes.some((n) => n.path?.endsWith('.test.ts'))).toBe(false);
  });

  it('keeps the most connected functions when there are too many', async () => {
    const helpersFile = Array.from(
      { length: 200 },
      (_, i) => `export function h${i}() {}`,
    ).join('\n');
    const caller = [
      "import * as h from './helpers';",
      ...Array.from(
        { length: 200 },
        (_, i) =>
          `export function c${i}() { h.h${i}(); ${i < 5 ? 'h.h0(); h.h1();' : ''} }`,
      ),
    ].join('\n');
    await file('src/helpers.ts', helpersFile);
    await file('src/callers.ts', caller);

    const { nodes, edges } = await callsExtractor.extract({
      repoDir: dir,
      paths: await listRepositoryFiles(dir),
      components: [],
      facts: new Map(),
      llm: {
        callTool: () => Promise.reject(new Error('unexpected model call')),
      },
    });
    expect(nodes).toHaveLength(120);
    expect(nodes.map((n) => n.id)).toContain('fn:src/helpers.ts#h0');
    const ids = new Set(nodes.map((n) => n.id));
    expect(edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
  });
});
