import { apiExtractor } from './api/index.js';
import { callsExtractor } from './calls/index.js';
import { ciCdExtractor } from './ci-cd.js';
import { dependenciesExtractor } from './dependencies.js';
import { infrastructureExtractor } from './infrastructure/index.js';
import { schemaExtractor } from './schema/index.js';
import type { ViewExtractor } from './view-graph.js';

// One per view the worker builds. Adding a view: write its extractor, add its id to
// VIEW_IDS, and register it here.
export const VIEW_EXTRACTORS: ViewExtractor[] = [
  dependenciesExtractor,
  schemaExtractor,
  apiExtractor,
  callsExtractor,
  infrastructureExtractor,
  ciCdExtractor,
];
