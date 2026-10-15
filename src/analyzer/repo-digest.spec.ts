import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Component } from './architecture.js';
import {
  buildMapDigest,
  buildTraceDigest,
  scanCode,
  componentLocator,
} from './repo-digest.js';
import { listRepositoryFiles } from './repository.js';

const component = (id: string, paths: string[]): Component => ({
  id,
  name: id,
  type: paths.length ? 'service' : 'data',
  tech: '',
  description: '',
  paths,
  entryPoint: '',
});

describe('componentLocator', () => {
  it('assigns a path to the longest matching prefix', () => {
    const locate = componentLocator([
      component('app', ['apps/web']),
      component('admin', ['./apps/web/admin/']),
    ]);

    expect(locate('apps/web/page.tsx')).toBe('app');
    expect(locate('apps/web/admin/index.ts')).toBe('admin');
    expect(locate('apps/webhooks/index.ts')).toBeUndefined();
  });
});

describe('repo digests', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'struct-digest-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const file = async (path: string, content = '') => {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  };

  it('includes the file tree and key files in the map digest', async () => {
    await file('package.json', '{"name":"shop"}');
    await file('src/main.ts', 'bootstrap();');
    await file('src/util/strings.ts', 'export const x = 1;');

    const digest = await buildMapDigest(dir, await listRepositoryFiles(dir));

    expect(digest).toContain('src/util/strings.ts');
    expect(digest).toContain('<file path="package.json">\n{"name":"shop"}');
    expect(digest).toContain('<file path="src/main.ts">');
    expect(digest).not.toContain('<file path="src/util/strings.ts">');
  });

  it('collects cross-component imports, packages, and env vars', async () => {
    await file(
      'api/src/orders.ts',
      [
        "import { verify } from '../../auth/token.js';",
        "import { DynamoDBClient } from '@aws-sdk/client-dynamodb';",
        "import { readFile } from 'node:fs/promises';",
        'const table = process.env.ORDERS_TABLE;',
        "fetch('https://api.stripe.com/v1/charges');",
      ].join('\n'),
    );
    await file('auth/token.ts', "export const verify = () => 'ok';");

    const components = [component('api', ['api']), component('auth', ['auth'])];
    const facts = await scanCode(
      dir,
      await listRepositoryFiles(dir),
      components,
    );
    const { digest, fileCounts } = buildTraceDigest(components, facts);

    expect(fileCounts).toEqual({ api: 1, auth: 1 });
    expect(digest).toContain(
      'Imports code from: auth ×1 (e.g. api/src/orders.ts → auth/token.ts)',
    );
    expect(digest).toContain('Packages: @aws-sdk/client-dynamodb (1)');
    expect(digest).not.toContain('node:fs');
    expect(digest).toContain('Environment variables: ORDERS_TABLE');
    expect(digest).toContain('URLs: api.stripe.com');
  });
});
