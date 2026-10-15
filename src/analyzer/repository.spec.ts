import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listRepositoryFiles, scanRepository } from './repository.js';

describe('listRepositoryFiles + scanRepository', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'struct-scan-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const file = async (path: string) => {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), '');
  };

  it('counts source files by language', async () => {
    await file('src/main.ts');
    await file('src/app/page.tsx');
    await file('scripts/seed.py');
    await file('README.md');

    expect(scanRepository(await listRepositoryFiles(dir))).toEqual({
      files: 3,
      languages: { TypeScript: 2, Python: 1 },
    });
  });

  it('lists files as sorted relative POSIX paths', async () => {
    await file('src/b.ts');
    await file('src/a/c.ts');
    await file('README.md');

    expect(await listRepositoryFiles(dir)).toEqual([
      'README.md',
      'src/a/c.ts',
      'src/b.ts',
    ]);
  });

  it('skips dependency, build, and git directories', async () => {
    await file('src/index.js');
    await file('node_modules/react/index.js');
    await file('dist/index.js');
    await file('.git/hooks/pre-commit.js');

    expect(scanRepository(await listRepositoryFiles(dir))).toEqual({
      files: 1,
      languages: { JavaScript: 1 },
    });
  });
});
