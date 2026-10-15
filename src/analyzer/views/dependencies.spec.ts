import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Component } from '../architecture.js';
import { scanCode } from '../repo-digest.js';
import { listRepositoryFiles } from '../repository.js';
import { dependenciesExtractor } from './dependencies.js';

const component = (id: string, paths: string[]): Component => ({
  id,
  name: id,
  type: 'service',
  tech: '',
  description: '',
  paths,
  entryPoint: '',
});

// These views never call the model.
const noModel = {
  callTool: () => Promise.reject(new Error('unexpected model call')),
};

describe('dependenciesExtractor', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'struct-deps-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const file = async (path: string, content: string) => {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  };

  // Runs the same scan the pipeline does, then the extractor.
  const extract = async (components: Component[]) => {
    const paths = await listRepositoryFiles(dir);
    const facts = await scanCode(dir, paths, components);
    return dependenciesExtractor.extract({
      repoDir: dir,
      paths,
      components,
      facts,
      llm: noModel,
    });
  };

  it('applies to repositories with manifests or scanned source', () => {
    expect(dependenciesExtractor.applies(['README.md', 'logo.png'])).toBe(
      false,
    );
    expect(dependenciesExtractor.applies(['go.mod'])).toBe(true);
    expect(dependenciesExtractor.applies(['src/main.ts'])).toBe(true);
  });

  it('maps imported packages with manifest versions, and imports between components', async () => {
    await file(
      'frontend/package.json',
      JSON.stringify({
        dependencies: { react: '^19.0.0', zod: '^3.25.0', lodash: '^4.17.0' },
        devDependencies: { vitest: '^4.0.0' },
      }),
    );
    await file(
      'frontend/src/app.tsx',
      [
        "import { useState } from 'react';",
        "import { z } from 'zod';",
        "import { Order } from '../../shared/types';",
      ].join('\n'),
    );
    await file('shared/types.ts', 'export type Order = { id: string };');
    await file(
      'backend/pyproject.toml',
      '[project]\nname = "api"\ndependencies = ["fastapi>=0.110", "PyYAML"]\n',
    );
    await file('backend/app.py', 'import fastapi\nimport yaml\n');
    await file(
      'svc/go.mod',
      [
        'module example.com/svc',
        'require (',
        '\tgithub.com/gin-gonic/gin v1.9.1',
        '\tgolang.org/x/sys v0.20.0 // indirect',
        ')',
      ].join('\n'),
    );
    await file('svc/main.go', 'package main');

    const { nodes, edges } = await extract([
      component('web', ['frontend']),
      component('shared', ['shared']),
      component('api', ['backend']),
      component('svc', ['svc']),
    ]);
    const node = (id: string) => nodes.find((n) => n.id === id);
    const edge = (from: string, to: string) =>
      edges.find((e) => e.from === from && e.to === to);

    expect(node('component:web')).toMatchObject({
      kind: 'component',
      group: 'Components',
      componentId: 'web',
      path: 'frontend/package.json',
      // lodash is declared but nothing imports it; vitest is a dev dependency.
      detail:
        '2 packages · imports 1 component · 1 declared but not imported in code',
    });
    expect(edge('component:web', 'component:shared')).toMatchObject({
      label: 'imports ×1',
    });
    expect(node('package:react')).toMatchObject({
      kind: 'package',
      group: 'Packages',
      detail: 'npm · ^19.0.0 · used by 1 component',
      path: 'frontend/package.json',
    });
    expect(edge('component:web', 'package:react')).toMatchObject({
      label: '×1',
    });
    expect(node('package:lodash')).toBeUndefined();
    expect(node('package:vitest')).toBeUndefined();

    expect(node('package:fastapi')).toMatchObject({
      detail: 'PyPI · >=0.110 · used by 1 component',
    });
    // The import name `yaml` doesn't match the distribution `PyYAML`; it still shows.
    expect(node('package:yaml')).toMatchObject({
      detail: 'used by 1 component',
    });

    // Go imports aren't scanned, so go.mod is the evidence; indirect ones are skipped.
    expect(
      edge('component:svc', 'package:github-com/gin-gonic/gin'),
    ).toMatchObject({ label: 'declared' });
    expect(nodes.some((n) => n.name === 'golang.org/x/sys')).toBe(false);
  });

  it('folds packages past the per-component limit into one node', async () => {
    const names = Array.from({ length: 20 }, (_, i) => `pkg-${i}`);
    await file('app/index.ts', names.map((n) => `import '${n}';`).join('\n'));

    const { nodes, edges } = await extract([component('app', ['app'])]);

    expect(nodes.filter((n) => n.kind === 'package')).toHaveLength(15);
    expect(nodes.find((n) => n.kind === 'more')).toMatchObject({
      id: 'more:app',
      name: '5 more packages',
    });
    expect(edges.filter((e) => e.from === 'component:app')).toHaveLength(16);
  });
});
