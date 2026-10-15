import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import type { AnalysisStats } from '../analyses/analysis.entity.js';

const run = promisify(execFile);

// An error whose message is safe and useful to show the user as the failure reason.
export class AnalysisError extends Error {}

// Shallow clone of a single branch; returns the commit SHA it checked out.
export async function cloneRepository(
  repoUrl: string,
  branch: string,
  dir: string,
): Promise<string> {
  try {
    await run(
      'git',
      [
        'clone',
        '--depth=1',
        '--single-branch',
        '--branch',
        branch,
        '--',
        repoUrl,
        dir,
      ],
      {
        timeout: 10 * 60 * 1000,
        // Fail on private repos instead of waiting for credentials that never come.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
    );
  } catch {
    throw new AnalysisError(
      `Couldn't clone branch "${branch}". Check that the repository is public and the branch exists.`,
    );
  }
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: dir });
  return stdout.trim();
}

// Directories that hold dependencies, build output, or VCS data rather than the project's code.
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  '.output',
  '.vercel',
  '.svelte-kit',
  '.turbo',
  '.cache',
]);

const LANGUAGES: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.cs': 'C#',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.swift': 'Swift',
  '.c': 'C',
  '.h': 'C',
  '.cpp': 'C++',
  '.hpp': 'C++',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.css': 'CSS',
  '.scss': 'CSS',
  '.html': 'HTML',
  '.sql': 'SQL',
  '.prisma': 'Prisma',
  '.tf': 'Terraform',
};

export const languageOf = (path: string): string | undefined =>
  LANGUAGES[extname(path).toLowerCase()];

// Keeps a single run's time and AI cost bounded.
export const MAX_SOURCE_FILES = 20_000;
// Guards the walk itself against repos full of assets or generated files.
const MAX_LISTED_FILES = 200_000;

// Every file outside dependency and build directories, as POSIX paths relative to `dir`.
export async function listRepositoryFiles(dir: string): Promise<string[]> {
  const paths: string[] = [];
  const walk = async (relative: string) => {
    const entries = await readdir(join(dir, relative), { withFileTypes: true });
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(path);
      } else if (entry.isFile()) {
        if (paths.push(path) > MAX_LISTED_FILES) {
          throw new AnalysisError(
            'This repository has too many files to analyze.',
          );
        }
      }
    }
  };
  await walk('');
  return paths.sort();
}

// Counts source files by language.
export function scanRepository(paths: string[]): AnalysisStats {
  const languages: Record<string, number> = {};
  let files = 0;
  for (const path of paths) {
    const language = languageOf(path);
    if (!language) continue;
    languages[language] = (languages[language] ?? 0) + 1;
    files++;
  }
  if (files > MAX_SOURCE_FILES) {
    throw new AnalysisError(
      `This repository has more than ${MAX_SOURCE_FILES.toLocaleString('en-US')} source files, which is over the current limit.`,
    );
  }
  return { files, languages };
}
