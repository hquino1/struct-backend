import type { Component } from '../architecture.js';
import { ImportGraph, endpointsByFile, suggestFiles } from './suggest.js';

const component = (fields: Partial<Component>): Component => ({
  id: 'api',
  name: 'API',
  type: 'service',
  tech: 'NestJS',
  description: '',
  paths: ['backend/src'],
  entryPoint: '',
  ...fields,
});

describe('endpointsByFile', () => {
  it('groups endpoint routes by file and sums their call sites', () => {
    const byFile = endpointsByFile({
      nodes: [
        {
          id: 'r1',
          name: 'GET /projects',
          kind: 'endpoint',
          detail: 'NestJS · findAll() · 3 call sites',
          group: 'API',
          path: 'backend/src/projects.controller.ts',
        },
        {
          id: 'r2',
          name: 'POST /projects',
          kind: 'endpoint',
          detail: 'NestJS · 1 call site',
          group: 'API',
          path: 'backend/src/projects.controller.ts',
        },
        // Callers aren't endpoints.
        {
          id: 'c1',
          name: 'Web',
          kind: 'client',
          detail: '4 calls to 2 endpoints',
          group: 'Callers',
          path: 'web/api.ts',
        },
      ],
      edges: [],
    });

    expect([...byFile]).toEqual([
      [
        'backend/src/projects.controller.ts',
        { routes: ['GET /projects', 'POST /projects'], callSites: 4 },
      ],
    ]);
  });
});

describe('suggestFiles', () => {
  it('ranks entry points first and explains each pick', () => {
    const imports = new ImportGraph();
    for (const from of ['a.ts', 'b.ts', 'c.ts']) {
      imports.add(`backend/src/${from}`, 'backend/src/db.ts');
    }

    const suggestions = suggestFiles({
      paths: [
        'backend/src/main.ts',
        'backend/src/db.ts',
        'backend/src/a.ts',
        'backend/src/schema.prisma',
      ],
      components: [component({ entryPoint: 'backend/src/main.ts' })],
      views: {
        schema: {
          nodes: [
            {
              id: 'users',
              name: 'users',
              kind: 'table',
              detail: '',
              group: 'Postgres',
              path: 'backend/src/schema.prisma',
            },
          ],
          edges: [],
        },
      },
      imports,
    });

    expect(suggestions).toEqual([
      { path: 'backend/src/main.ts', reason: 'Entry point of API' },
      { path: 'backend/src/schema.prisma', reason: 'Defines the data model' },
      { path: 'backend/src/db.ts', reason: 'Imported by 3 files' },
    ]);
  });

  it('leaves out tests, lockfiles, and paths not in the repository', () => {
    const suggestions = suggestFiles({
      paths: ['src/app.spec.ts', 'package-lock.json'],
      components: [
        component({ entryPoint: 'src/app.spec.ts' }),
        component({ id: 'web', entryPoint: 'package-lock.json' }),
        component({ id: 'gone', entryPoint: 'src/missing.ts' }),
      ],
      views: {},
      imports: new ImportGraph(),
    });

    expect(suggestions).toEqual([]);
  });

  it('caps the list', () => {
    const paths = Array.from({ length: 30 }, (_, i) => `src/c${i}.ts`);
    const suggestions = suggestFiles({
      paths,
      components: paths.map((p, i) =>
        component({ id: `c${i}`, entryPoint: p }),
      ),
      views: {},
      imports: new ImportGraph(),
      limit: 5,
    });

    expect(suggestions).toHaveLength(5);
  });
});
