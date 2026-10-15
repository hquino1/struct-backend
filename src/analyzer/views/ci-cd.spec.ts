import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Component } from '../architecture.js';
import { ciCdExtractor } from './ci-cd.js';

const component = (id: string, paths: string[]): Component => ({
  id,
  name: id,
  type: 'service',
  tech: '',
  description: '',
  paths,
  entryPoint: '',
});
const components = [
  component('api', ['backend']),
  component('web', ['frontend']),
];

const CI = `
name: CI
on:
  push:
    branches: [main]
    paths: ['backend/**']
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: backend
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run build
  test:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: npm --prefix frontend test
  deploy:
    needs: [build, test]
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: ./deploy.sh
  shared:
    uses: ./.github/workflows/reusable.yml
`;

const RELEASE = `
name: Release
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: echo publish
`;

const REUSABLE = `
on: workflow_call
jobs:
  lint:
    runs-on: ubuntu-latest
    steps: []
`;

const GITLAB = `
stages: [build, test, deploy]
.defaults: &defaults
  image: node:22
compile:
  <<: *defaults
  stage: build
  script: cd backend && npm run build
unit:
  stage: test
  script: npm test
e2e:
  stage: test
  script: npm run e2e
ship:
  stage: deploy
  needs: [unit]
  script: ./ship.sh
`;

// These views never call the model.
const noModel = {
  callTool: () => Promise.reject(new Error('unexpected model call')),
};

describe('ciCdExtractor', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'struct-ci-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const file = async (path: string, content: string) => {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  };

  const extract = (paths: string[]) =>
    ciCdExtractor.extract({
      repoDir: dir,
      paths,
      components,
      facts: new Map(),
      llm: noModel,
    });

  it('applies only to repositories with CI configuration', () => {
    expect(ciCdExtractor.applies(['src/main.ts', 'README.md'])).toBe(false);
    expect(ciCdExtractor.applies(['.github/workflows/ci.yml'])).toBe(true);
    expect(ciCdExtractor.applies(['.gitlab-ci.yml'])).toBe(true);
  });

  it('maps GitHub Actions triggers, jobs, and the jobs they need', async () => {
    const paths = [
      '.github/workflows/ci.yml',
      '.github/workflows/release.yaml',
      '.github/workflows/reusable.yml',
    ];
    await file(paths[0]!, CI);
    await file(paths[1]!, RELEASE);
    await file(paths[2]!, REUSABLE);
    const { nodes, edges } = await extract(paths);
    const node = (id: string) => nodes.find((n) => n.id === id);
    const edge = (from: string, to: string) =>
      edges.find((e) => e.from === from && e.to === to);
    const ci = '.github/workflows/ci.yml';

    expect(node(`${ci}#on`)).toMatchObject({
      name: 'push · pull_request',
      kind: 'trigger',
      detail: 'Branches: main',
      group: 'CI',
      componentId: 'api',
    });
    expect(node(`${ci}#build`)).toMatchObject({
      kind: 'job',
      detail: 'ubuntu-latest · 2 steps',
      componentId: 'api',
    });
    expect(node(`${ci}#test`)).toMatchObject({ componentId: 'web' });
    expect(node(`${ci}#deploy`)).toMatchObject({ kind: 'deploy' });
    expect(node(`${ci}#shared`)).toMatchObject({ kind: 'workflow' });

    // Jobs without `needs` start from the trigger; the rest wait for what they need.
    expect(edge(`${ci}#on`, `${ci}#build`)).toBeDefined();
    expect(edge(`${ci}#build`, `${ci}#test`)).toMatchObject({ label: 'needs' });
    expect(edge(`${ci}#test`, `${ci}#deploy`)).toBeDefined();
    expect(edge(`${ci}#on`, `${ci}#test`)).toBeUndefined();

    // Cross-workflow links: a reusable-workflow call and a workflow_run trigger.
    expect(
      edge(`${ci}#shared`, '.github/workflows/reusable.yml#on'),
    ).toMatchObject({ label: 'calls' });
    expect(
      edge(`${ci}#deploy`, '.github/workflows/release.yaml#on'),
    ).toMatchObject({ label: 'on completion' });
    // Only the jobs nothing else waits for finish the workflow.
    expect(
      edge(`${ci}#build`, '.github/workflows/release.yaml#on'),
    ).toBeUndefined();
  });

  it('maps GitLab CI stages, with explicit needs overriding stage order', async () => {
    await file('.gitlab-ci.yml', GITLAB);
    const { nodes, edges } = await extract(['.gitlab-ci.yml']);
    const id = (job: string) => `.gitlab-ci.yml#${job}`;
    const into = (job: string) =>
      edges
        .filter((e) => e.to === id(job))
        .map((e) => e.from)
        .sort();

    // Hidden `.defaults` is a template, not a job.
    expect(nodes.map((n) => n.name)).toEqual([
      'Pipeline',
      'compile',
      'unit',
      'e2e',
      'ship',
    ]);
    expect(nodes.find((n) => n.name === 'compile')).toMatchObject({
      detail: 'Stage build · node:22',
      componentId: 'api',
    });
    expect(nodes.find((n) => n.name === 'ship')).toMatchObject({
      kind: 'deploy',
    });
    expect(into('compile')).toEqual(['.gitlab-ci.yml#on']);
    expect(into('unit')).toEqual([id('compile')]);
    expect(into('e2e')).toEqual([id('compile')]);
    expect(into('ship')).toEqual([id('unit')]);
  });

  it('skips a workflow file that is not valid YAML', async () => {
    await file('.github/workflows/broken.yml', 'jobs: [unclosed');
    await file('.github/workflows/ci.yml', CI);

    const { nodes } = await extract([
      '.github/workflows/broken.yml',
      '.github/workflows/ci.yml',
    ]);
    expect(nodes.some((n) => n.path === '.github/workflows/broken.yml')).toBe(
      false,
    );
    expect(nodes.length).toBeGreaterThan(0);
  });
});
