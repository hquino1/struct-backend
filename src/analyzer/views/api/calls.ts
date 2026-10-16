import { normalizePath } from './routes.js';

// HTTP calls made from code: a path literal passed to something that looks like an HTTP
// client (`fetch`, `axios.get`, `api.post`, or a wrapper such as `apiFetch`). The literal
// may start with a base URL (`${API_URL}/orders`), which is dropped.

export interface Call {
  method: string | undefined; // undefined when it can't be read from the call
  path: string;
  // Set when the call names another host, e.g. a third-party API.
  host?: string;
  file: string;
  line: number;
  // Where the call starts in the file's text.
  offset: number;
  snippet: string;
}

const JS_SOURCE = /\.[cm]?[jt]sx?$/;
const PY_SOURCE = /\.py$/;
const TEST = /\.(spec|test)\.|(^|\/)(tests?|__tests__|__mocks__)\//;

// Callee names that read as HTTP clients, then the path literal.
// The quote is a named group because the patterns below put it at different positions.
const LITERAL = String.raw`(?<quote>['"\`])((?:\$\{[^}]*\})?(?:https?:\/\/[^\/'"\`\s]+)?\/[^'"\`\s]*)\k<quote>`;
const JS_CLIENT = new RegExp(
  String.raw`\b((?:[\w$]+\.)*[\w$]*(?:fetch|axios|request|api|http|client|ky|got|superagent)[\w$]*)\s*(?:<(?:[^<>]|<[^<>]*>)*>)?\s*\(\s*` +
    LITERAL,
  'gi',
);
const JS_VERB = new RegExp(
  String.raw`\b((?:[\w$]+\.)+(get|post|put|patch|delete|head))\s*(?:<(?:[^<>]|<[^<>]*>)*>)?\s*\(\s*` +
    LITERAL,
  'gi',
);
const PY_CLIENT =
  /\b(?:requests|httpx|session|client|self\.\w*(?:client|session)\w*)\.(get|post|put|patch|delete|head|request)\(\s*(?:['"](\w+)['"]\s*,\s*)?f?(['"])((?:\{[^}]*\})?(?:https?:\/\/[^/'"\s]+)?\/[^'"\s]*)\3/g;
const METHOD_OPTION = /method\s*:\s*['"`](\w+)['"`]/i;

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/;

function parsePath(raw: string) {
  let path = raw.replace(/^\$\{[^}]*\}/, '').replace(/^\{[^}]*\}/, '');
  let host: string | undefined;
  const absolute = /^https?:\/\/([^/]+)(\/.*)?$/.exec(path);
  if (absolute) {
    host = absolute[1]!;
    path = absolute[2] ?? '/';
    if (LOCAL_HOST.test(host)) host = undefined;
  }
  // Interpolated segments become parameters: `/orders/${id}` -> `/orders/:param`.
  path = path.replace(/\$\{[^}]*\}|\{[^}]*\}/g, ':param');
  return { path: normalizePath(path), ...(host && { host }) };
}

const lineAt = (text: string, index: number) =>
  text.slice(0, index).split('\n').length;

// The call's own text, up to its end or the next statement, for reading its options.
const callText = (text: string, index: number) => {
  const rest = text.slice(index, index + 600);
  const end = rest.search(/\)\s*;|\n\s*\n/);
  return end > 0 ? rest.slice(0, end) : rest;
};

export function findCalls(
  texts: Map<string, string>,
  serverFiles: Set<string>,
) {
  const calls: Call[] = [];
  for (const [file, text] of texts) {
    if (TEST.test(file)) continue;
    const seen = new Set<number>();
    const add = (index: number, method: string | undefined, raw: string) => {
      if (seen.has(index)) return;
      seen.add(index);
      const { path, host } = parsePath(raw);
      if (path === '/' && !host) return;
      calls.push({
        method,
        path,
        ...(host && { host }),
        file,
        line: lineAt(text, index),
        offset: index,
        snippet: text
          .slice(index, index + 160)
          .split('\n')
          .slice(0, 3)
          .join('\n'),
      });
    };
    if (JS_SOURCE.test(file)) {
      for (const m of text.matchAll(JS_CLIENT)) {
        const callee = m[1]!;
        const verb = /\.(get|post|put|patch|delete|head)$/i.exec(callee)?.[1];
        const option = METHOD_OPTION.exec(callText(text, m.index))?.[1];
        add(
          m.index,
          (
            verb ??
            option ??
            (/fetch/i.test(callee) ? 'GET' : undefined)
          )?.toUpperCase(),
          m[3]!,
        );
      }
      // `router.get('/x', handler)` in a server file is a route, not a call.
      if (!serverFiles.has(file)) {
        for (const m of text.matchAll(JS_VERB))
          add(m.index, m[2]!.toUpperCase(), m[4]!);
      }
    } else if (PY_SOURCE.test(file)) {
      for (const m of text.matchAll(PY_CLIENT)) {
        const method = m[1] === 'request' ? m[2] : m[1];
        add(m.index, method?.toUpperCase(), m[4]!);
      }
    }
  }
  return calls;
}
