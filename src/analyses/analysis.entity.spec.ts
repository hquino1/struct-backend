import {
  HEARTBEAT_TIMEOUT_MS,
  NOT_STARTED,
  toAnalysis,
  type ProjectAnalysis,
} from './analysis.entity.js';
import { toProject, type ProjectItem } from '../projects/project.entity.js';

const now = Date.parse('2026-10-14T12:00:00.000Z');
const running = (fields: Partial<ProjectAnalysis> = {}): ProjectAnalysis => ({
  status: 'RUNNING',
  step: 'map',
  analysisId: 'a1',
  startedAt: '2026-10-14T11:58:00.000Z',
  heartbeatAt: new Date(now - 60_000).toISOString(),
  ...fields,
});

describe('toAnalysis', () => {
  it('returns null for a project that was never analyzed', () => {
    expect(toAnalysis('p1', NOT_STARTED, now)).toBeNull();
    // Projects created before the analysis attribute existed.
    expect(toAnalysis('p1', undefined, now)).toBeNull();
  });

  it('returns a running analysis with a recent heartbeat as-is', () => {
    expect(toAnalysis('p1', running(), now)).toMatchObject({
      projectId: 'p1',
      status: 'RUNNING',
      step: 'map',
    });
  });

  it('reports a run whose heartbeat went stale as failed', () => {
    const stale = running({
      heartbeatAt: new Date(now - HEARTBEAT_TIMEOUT_MS - 1).toISOString(),
    });

    expect(toAnalysis('p1', stale, now)).toMatchObject({
      status: 'FAILED',
      step: 'map',
      error: expect.stringContaining('stopped responding'),
    });
  });

  it('leaves finished runs alone however old they are', () => {
    const done = running({
      status: 'COMPLETE',
      heartbeatAt: '2020-01-01T00:00:00.000Z',
    });

    expect(toAnalysis('p1', done, now)?.status).toBe('COMPLETE');
  });
});

describe('toProject', () => {
  const project = (analysis?: ProjectAnalysis): ProjectItem => ({
    PK: 'USER#u1',
    SK: 'PROJECT#p1',
    name: 'shop',
    repoUrl: 'https://github.com/acme/shop',
    branch: 'main',
    createdAT: '2026-10-14T11:00:00.000Z',
    analysis,
  });

  it('exposes the analysis status and step', () => {
    expect(toProject(project(NOT_STARTED))).toMatchObject({
      analysisStatus: 'NOT_STARTED',
      analysisStep: null,
    });
    // toProject checks staleness against the real clock.
    const live = running({
      step: 'trace',
      heartbeatAt: new Date().toISOString(),
    });
    expect(toProject(project(live))).toMatchObject({
      analysisStatus: 'RUNNING',
      analysisStep: 'trace',
    });
  });

  it('treats projects without the attribute as not started', () => {
    expect(toProject(project())).toMatchObject({
      analysisStatus: 'NOT_STARTED',
      analysisStep: null,
    });
  });
});
