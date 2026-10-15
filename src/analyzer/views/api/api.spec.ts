import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Component } from '../../architecture.js';
import { listRepositoryFiles } from '../../repository.js';
import type { ViewContext, ViewGraph } from '../view-graph.js';
import { apiExtractor } from './index.js';
import { normalizePath } from './routes.js';

const EXPRESS = `
import express from 'express';
const router = express.Router();
router.get('/orders', listOrders);
router.post('/orders', (req, res) => res.json({}));
router.get('/orders/:id', getOrder);
router.route('/carts/:id').get(getCart).delete(clearCart);
export default router;
`;

const FASTAPI = `
from fastapi import APIRouter
router = APIRouter(prefix="/payments")

@router.post("/{payment_id}/refund")
async def refund(payment_id: str):
    return {}
`;

const NEXT_ROUTE = `
export async function GET(request: Request) { return Response.json([]); }
export const POST = async () => Response.json({});
`;

const OPENAPI = `
openapi: 3.0.0
paths:
  /orders:
    get: { operationId: listOrders }
  /reports/{year}:
    get: { operationId: yearlyReport }
`;

const CLIENT = `
import axios from 'axios';
export const api = axios.create({ baseURL: '/api' });
export const listOrders = () => api.get('/api/orders');
export const order = (id: string) => api.get(\`/api/orders/\${id}\`);
export async function pay(id: string) {
  return fetch(\`\${BASE}/payments/\${id}/refund\`, { method: 'POST' });
}
export const legacy = () => request('/v1/legacy-thing');
export const weird = () => apiCall('/shop/v2/checkout');
export const stripe = () => fetch('https://api.stripe.com/v1/charges', { method: 'POST' });
export const goToOrders = () => navigate('/orders');
`;

const component = (id: string, paths: string[]): Component => ({
  id,
  name: id,
  type: 'service',
  tech: '',
  description: '',
  paths,
  entryPoint: '',
});

describe('normalizePath', () => {
  it('reads every framework parameter style the same way', () => {
    expect(normalizePath('/orders/{id}')).toBe('/orders/:id');
    expect(normalizePath('orders/[id]/')).toBe('/orders/:id');
    expect(normalizePath('/files/<path:name>?x=1')).toBe('/files/:name');
    expect(normalizePath('/docs/[...slug]')).toBe('/docs/:slug');
  });
});

describe('apiExtractor', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'struct-api-'));
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
    edgesTo: (id: string) => edges.filter((e) => e.to === id),
  });

  it('matches calls to routes across frameworks, and asks the model about the rest', async () => {
    await file('server/src/orders.ts', EXPRESS);
    await file('payments/app/routes.py', FASTAPI);
    await file('web/app/api/health/route.ts', NEXT_ROUTE);
    await file('server/openapi.yaml', OPENAPI);
    await file('web/src/client.ts', CLIENT);
    const asked: string[] = [];
    const llm: ViewContext['llm'] = {
      callTool: (request) => {
        asked.push(request.prompt);
        // The checkout call lives under a prefix the code adds elsewhere; say it reaches
        // POST /orders, looked up by its index in the prompt.
        const lines = request.prompt
          .split('\n')
          .filter((l) => /^\d+: /.test(l));
        const index = (text: string) =>
          Number(lines.find((l) => l.includes(text))!.split(':')[0]);
        return Promise.resolve({
          matches: [
            {
              call: index('/shop/v2/checkout ('),
              route: index('POST /orders ('),
            },
          ],
        } as never);
      },
    };
    const graph = await apiExtractor.extract({
      repoDir: dir,
      paths: await listRepositoryFiles(dir),
      components: [
        component('web', ['web']),
        component('server', ['server']),
        component('payments', ['payments']),
      ],
      facts: new Map(),
      llm,
    });
    const { node, edgesTo } = helpers(graph);
    const route = (method: string, path: string, file: string) =>
      `route:${method} ${path}@${file}`;
    const orders = 'server/src/orders.ts';

    // Routes from Express (incl. chained), FastAPI with its router prefix, and Next.js.
    expect(node(route('GET', '/orders/:id', orders))).toMatchObject({
      kind: 'endpoint',
      group: 'server',
      componentId: 'server',
    });
    expect(node(route('DELETE', '/carts/:id', orders))).toBeDefined();
    expect(
      node(
        route('POST', '/payments/:payment_id/refund', 'payments/app/routes.py'),
      ),
    ).toMatchObject({ detail: 'FastAPI · refund() · 1 call site' });
    expect(
      node(route('POST', '/api/health', 'web/app/api/health/route.ts')),
    ).toBeDefined();
    // The spec adds only what the code doesn't declare.
    expect(
      node(route('GET', '/reports/:year', 'server/openapi.yaml')),
    ).toBeDefined();
    expect(
      node(route('GET', '/orders', 'server/openapi.yaml')),
    ).toBeUndefined();

    // `/api/orders` reaches `/orders` through a proxy prefix; `${BASE}` is dropped.
    expect(edgesTo(route('GET', '/orders', orders))).toEqual([
      { from: 'caller:web', to: route('GET', '/orders', orders), label: '' },
    ]);
    expect(edgesTo(route('GET', '/orders/:id', orders))).toHaveLength(1);
    expect(
      edgesTo(
        route('POST', '/payments/:payment_id/refund', 'payments/app/routes.py'),
      ),
    ).toHaveLength(1);

    // Only the calls that didn't line up went to the model.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('/shop/v2/checkout');
    expect(asked[0]).toContain('/v1/legacy-thing');
    expect(asked[0]).not.toContain('/api/orders (');
    expect(edgesTo(route('POST', '/orders', orders))).toEqual([
      {
        from: 'caller:web',
        to: route('POST', '/orders', orders),
        label: 'matched by AI',
      },
    ]);

    expect(node('missing:ANY /v1/legacy-thing')).toMatchObject({
      kind: 'missing',
      group: 'Not found on server',
    });
    expect(node('remote:POST api.stripe.com/v1/charges')).toMatchObject({
      kind: 'remote',
      group: 'External APIs',
      detail: 'On api.stripe.com',
    });
    // Navigation isn't an HTTP call.
    expect(graph.nodes.some((n) => n.name.includes('navigate'))).toBe(false);
    expect(node('caller:web')).toMatchObject({
      group: 'Callers',
      componentId: 'web',
    });
  });

  it('finds NestJS routes under the global prefix without asking the model', async () => {
    await file(
      'api/src/main.ts',
      "const app = await NestFactory.create(AppModule);\napp.setGlobalPrefix('v1');",
    );
    await file(
      'api/src/orders.controller.ts',
      `@Controller('orders/:orderId')
export class OrdersController {
  @Get('items')
  @HttpCode(200)
  items(@Param('orderId', ParseUUIDPipe) orderId: string) {}

  @Post()
  async create() {}
}`,
    );
    await file(
      'web/src/api.ts',
      'export const items = (id: string) => apiFetch(`${API}/v1/orders/${id}/items`);',
    );
    const graph = await apiExtractor.extract({
      repoDir: dir,
      paths: await listRepositoryFiles(dir),
      components: [component('web', ['web']), component('api', ['api'])],
      facts: new Map(),
      llm: {
        callTool: () => Promise.reject(new Error('unexpected model call')),
      },
    });
    const items =
      'route:GET /v1/orders/:orderId/items@api/src/orders.controller.ts';

    expect(helpers(graph).node(items)).toMatchObject({
      detail: 'NestJS · items() · 1 call site',
    });
    expect(
      helpers(graph).node(
        'route:POST /v1/orders/:orderId@api/src/orders.controller.ts',
      ),
    ).toBeDefined();
    expect(helpers(graph).edgesTo(items)).toHaveLength(1);
  });

  it('returns nothing without routes or calls', async () => {
    await file('src/main.ts', 'console.log("hi");');
    const { nodes } = await apiExtractor.extract({
      repoDir: dir,
      paths: await listRepositoryFiles(dir),
      components: [],
      facts: new Map(),
      llm: {
        callTool: () => Promise.reject(new Error('unexpected model call')),
      },
    });
    expect(nodes).toEqual([]);
  });
});
