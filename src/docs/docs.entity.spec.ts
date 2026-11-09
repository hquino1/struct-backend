import { HEARTBEAT_TIMEOUT_MS } from '../analyses/analysis.entity.js';
import {
  isDocumentable,
  packPaths,
  toDocsState,
  unpackPaths,
  type FileDoc,
  type ProjectDocs,
} from './docs.entity.js';

const now = Date.parse('2026-11-07T12:00:00.000Z');
const suggestions = [
  { path: 'src/main.ts', reason: 'Entry point of API' },
  { path: 'src/db.ts', reason: 'Imported by 9 files' },
];
const doc = (path: string): FileDoc => ({
  path,
  commit: 'abc',
  hash: 'h',
  summary: '',
  purpose: '',
  keyParts: [],
  notes: [],
  usedBy: [],
  dependsOn: [],
  endpoints: [],
  truncated: false,
  generatedAt: '',
});

describe('toDocsState', () => {
  it('documents the suggestions in auto mode, and starts out not started', () => {
    expect(toDocsState(undefined, suggestions, [], now)).toMatchObject({
      mode: 'auto',
      selection: ['src/main.ts', 'src/db.ts'],
      status: 'NOT_STARTED',
      failed: [],
    });
  });

  it("documents the user's pick in manual mode", () => {
    const docs: ProjectDocs = {
      mode: 'manual',
      selection: ['src/routes.ts'],
      status: 'COMPLETE',
    };
    expect(toDocsState(docs, suggestions, [], now).selection).toEqual([
      'src/routes.ts',
    ]);
  });

  it('reports a run whose heartbeat went stale as failed', () => {
    const docs: ProjectDocs = {
      mode: 'auto',
      status: 'RUNNING',
      heartbeatAt: new Date(now - HEARTBEAT_TIMEOUT_MS - 1).toISOString(),
    };
    expect(toDocsState(docs, suggestions, [], now)).toMatchObject({
      status: 'FAILED',
      error: 'Writing the docs stopped responding. Try again.',
    });
  });

  it('lists docs by path', () => {
    const state = toDocsState(undefined, [], [doc('b.ts'), doc('a.ts')], now);
    expect(state.docs.map((d) => d.path)).toEqual(['a.ts', 'b.ts']);
  });
});

describe('isDocumentable', () => {
  it.each([
    'src/main.ts',
    'app/models.py',
    'infra/main.tf',
    '.github/workflows/ci.yml',
    'Dockerfile',
    'prisma/schema.prisma',
  ])('accepts %s', (path) => expect(isDocumentable(path)).toBe(true));

  it.each([
    'package-lock.json',
    'web/pnpm-lock.yaml',
    'dist/app.min.js',
    'src/types.d.ts',
    'logo.png',
    'README.md',
  ])('rejects %s', (path) => expect(isDocumentable(path)).toBe(false));
});

describe('packPaths', () => {
  it('round-trips and compresses a large path list', () => {
    const paths = Array.from(
      { length: 20_000 },
      (_, i) => `packages/app/src/features/feature-${i}/index.ts`,
    );
    const packed = packPaths(paths);
    expect(unpackPaths(packed)).toEqual(paths);
    expect(packed.byteLength).toBeLessThan(350_000);
  });
});
