import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Component } from '../../architecture.js';
import { listRepositoryFiles } from '../../repository.js';
import type { ViewGraph } from '../view-graph.js';
import { routePath } from './find.js';
import { screensExtractor } from './index.js';

const SERVER = `
import express from 'express';
const router = express.Router();
router.get('/orders', listOrders);
router.get('/orders/:id', getOrder);
router.post('/orders/:id/refund', refund);
router.get('/me', me);
router.get('/reports', reports);
export default router;
`;

// A barrel of API functions: a screen importing one of them reaches only that one.
const API_BARREL = `
export * from './orders';
export { reports } from './reports';
`;
const API_ORDERS = `
import { http } from './http';
export const listOrders = () => http.get('/orders');
export const getOrder = (id: string) => http.get(\`/orders/\${id}\`);
export async function refundOrder(id: string) {
  return http.post(\`/orders/\${id}/refund\`);
}
`;
const API_REPORTS = `export const reports = () => fetch('/reports');\n`;
const API_USER = `
export const userApi = {
  me: () => fetch('/me'),
  avatar: () => fetch('https://cdn.example.com/avatar'),
};
`;

const NEXT_CONFIG = 'module.exports = {};\n';

const ORDERS_PAGE = `
import { listOrders } from '@/lib/api';
import { Header } from '@/components/header';

export default async function OrdersPage() {
  const orders = await listOrders();
  return <main><Header /><ul>{orders.map((o) => <li key={o.id}>{o.id}</li>)}</ul></main>;
}
`;

const ORDER_PAGE = `
import { RefundButton } from './refund-button';
import { useOrder } from '@/lib/hooks';
import { Header } from '@/components/header';

export default function OrderPage({ params }) {
  const order = useOrder(params.id);
  return <section><Header /><RefundButton id={params.id} /></section>;
}
`;

const REFUND_BUTTON = `
'use client';
import { refundOrder } from '@/lib/api';

export function RefundButton({ id }) {
  const confirmRefund = async () => {
    await refundOrder(id);
  };
  return <button onClick={confirmRefund}>Refund</button>;
}
`;

const HOOKS = `
import { useQuery } from '@tanstack/react-query';
import { getOrder } from './api';
export const useOrder = (id: string) =>
  useQuery({ queryKey: ['order', id], queryFn: () => getOrder(id) });
`;

const HEADER = `
import { userApi } from '@/lib/user';
export function Header() {
  const me = useEffectOnce(() => userApi.me());
  useEffect(() => { userApi.me(); }, []);
  return <header />;
}
`;

const SETTINGS_PAGE = `
import { Header } from '@/components/header';
export default function Settings() { return <Header />; }
`;
const HELP_PAGE = `
import { Header } from '@/components/header';
export default function Help() { return <Header />; }
`;

const LAYOUT = `
import { reports } from '@/lib/api';
export default function ShopLayout({ children }) {
  useEffect(() => { reports(); }, []);
  return <div>{children}</div>;
}
`;

const component = (
  id: string,
  type: Component['type'],
  paths: string[],
): Component => ({
  id,
  name: id,
  type,
  tech: '',
  description: '',
  paths,
  entryPoint: '',
});

describe('routePath', () => {
  it('reads each router naming scheme as a plain path', () => {
    expect(routePath('(shop)/orders/[id]'.split('/'))).toBe('/orders/:id');
    expect(routePath('/_app/projects/$projectId'.split('/'))).toBe(
      '/projects/:projectId',
    );
    expect(routePath('docs/[...slug]/index'.split('/'))).toBe('/docs/:slug');
    expect(routePath(['@modal', 'login'])).toBe('/login');
  });
});

describe('screensExtractor', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'struct-screens-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const file = async (path: string, content: string) => {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  };

  const extract = async (components: Component[]) =>
    screensExtractor.extract({
      repoDir: dir,
      paths: await listRepositoryFiles(dir),
      components,
      facts: new Map(),
      llm: {
        callTool: () => Promise.reject(new Error('unexpected model call')),
      },
    });

  const helpers = ({ nodes, edges }: ViewGraph) => {
    const byName = (name: string) => nodes.find((n) => n.name === name);
    return {
      byName,
      // The endpoints a screen links to, with each link's label.
      links: (name: string) =>
        Object.fromEntries(
          edges
            .filter((e) => e.from === byName(name)?.id)
            .map((e) => [nodes.find((n) => n.id === e.to)!.name, e.label]),
        ),
    };
  };

  it('follows Next.js pages to the endpoints they call, and says when', async () => {
    await file('server/src/routes.ts', SERVER);
    await file('web/next.config.js', NEXT_CONFIG);
    await file('web/src/app/(shop)/orders/page.tsx', ORDERS_PAGE);
    await file('web/src/app/(shop)/orders/[id]/page.tsx', ORDER_PAGE);
    await file(
      'web/src/app/(shop)/orders/[id]/refund-button.tsx',
      REFUND_BUTTON,
    );
    await file('web/src/app/(shop)/layout.tsx', LAYOUT);
    await file('web/src/app/settings/page.tsx', SETTINGS_PAGE);
    await file('web/src/app/help/page.tsx', HELP_PAGE);
    await file('web/src/components/header.tsx', HEADER);
    await file('web/src/lib/api/index.ts', API_BARREL);
    await file('web/src/lib/api/orders.ts', API_ORDERS);
    await file('web/src/lib/api/reports.ts', API_REPORTS);
    await file('web/src/lib/api/http.ts', 'export const http = {};\n');
    await file('web/src/lib/hooks.ts', HOOKS);
    await file('web/src/lib/user.ts', API_USER);

    const graph = await extract([
      component('server', 'service', ['server']),
      component('web', 'frontend', ['web']),
    ]);
    const { byName, links } = helpers(graph);

    expect(byName('/orders')).toMatchObject({
      kind: 'page',
      group: 'Screens',
      path: 'web/src/app/(shop)/orders/page.tsx',
      componentId: 'web',
      detail: '<OrdersPage> · 1 on load',
    });
    // Awaited in a server component: on load. Only `listOrders` from the barrel.
    expect(links('/orders')).toEqual({ 'GET /orders': 'on load' });
    // A query hook loads; a click handler in a child component acts.
    expect(links('/orders/:id')).toEqual({
      'GET /orders/:id': 'on load',
      'POST /orders/:id/refund': 'on action',
    });
    // The layout is its own screen, so its calls aren't repeated on every page in it.
    expect(links('/ layout')).toEqual({ 'GET /reports': 'on load' });
    expect(byName('/ layout')).toMatchObject({ kind: 'layout' });

    // Every page renders the header, so its call is drawn once, from the shared node.
    expect(links('Every page')).toEqual({ 'GET /me': 'on load' });
    expect(links('/settings')).toEqual({});
    expect(byName('/settings')?.detail).toContain('no API calls found');
    // Only the method the header calls: `userApi.avatar` would reach another host.
    expect(byName('cdn.example.com')).toBeUndefined();

    expect(byName('GET /orders/:id')).toMatchObject({
      kind: 'endpoint',
      group: 'server',
      componentId: 'server',
    });
    expect(byName('GET /orders/:id')?.detail).toContain('used by 1 screen');
    expect(byName('GET /me')?.detail).toContain('used by nearly every page');
  });

  it('reads React Router routes, lazy pages, loaders, and other hosts', async () => {
    await file('server/src/routes.ts', SERVER);
    await file(
      'web/src/main.tsx',
      `
import { createBrowserRouter } from 'react-router-dom';
import { Shell } from './shell';
import { getOrder } from './api';
const Orders = lazy(() => import('./pages/orders'));

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <Orders /> },
      {
        path: 'orders/:id',
        element: <Order />,
        loader: ({ params }) => getOrder(params.id),
      },
    ],
  },
]);
function Order() { return null; }
`,
    );
    await file(
      'web/src/app.tsx',
      `
import { Routes, Route } from 'react-router-dom';
import { Profile } from './pages/profile';
export function App() {
  return (
    <Routes>
      <Route path="/account">
        <Route path="profile" element={<Profile />} />
      </Route>
    </Routes>
  );
}
`,
    );
    await file(
      'web/src/pages/orders.tsx',
      `
import { listOrders } from '../api';
export default function Orders() {
  const { data } = useSWR('orders', listOrders);
  return <ul />;
}
`,
    );
    await file(
      'web/src/pages/profile.tsx',
      `
export function Profile() {
  const { mutate } = useMutation({ mutationFn: () => fetch('https://api.stripe.com/v1/customers', { method: 'POST' }) });
  return <form />;
}
`,
    );
    await file('web/src/shell.tsx', 'export const Shell = () => <div />;\n');
    await file(
      'web/src/api.ts',
      `
export const listOrders = () => fetch('/orders');
export const getOrder = (id: string) => fetch(\`/orders/\${id}\`);
`,
    );

    const graph = await extract([component('web', 'frontend', ['web'])]);
    const { byName, links } = helpers(graph);

    expect(byName('/ layout')).toMatchObject({
      kind: 'layout',
      path: 'web/src/main.tsx',
    });
    // The index route, through a lazy import and an SWR fetcher.
    expect(links('/')).toEqual({ 'GET /orders': 'on load' });
    // The loader runs as the route loads, alongside the component.
    expect(links('/orders/:id')).toEqual({ 'GET /orders/:id': 'on load' });
    // Nested JSX routes join their paths; a mutation to another host is an action.
    expect(links('/account/profile')).toEqual({
      'api.stripe.com': 'on action',
    });
    expect(byName('api.stripe.com')).toMatchObject({
      kind: 'remote',
      group: 'External APIs',
    });
  });

  it('draws nothing for a repository without screens', async () => {
    await file('server/src/routes.ts', SERVER);
    const graph = await extract([]);
    expect(graph).toEqual({ nodes: [], edges: [] });
  });
});
