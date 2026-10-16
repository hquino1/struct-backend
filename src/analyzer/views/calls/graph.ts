import ts from 'typescript';
import { isTestFile, readText, resolveJsImport } from '../../repo-digest.js';

// Which functions call which, for JavaScript and TypeScript. Each file is parsed for its
// syntax only (no type-checking), and calls are resolved through what the syntax shows:
// imports and re-exports, same-file functions, `this.method()`, `obj.method()` on object
// literals, and `this.service.method()` where the property's type is declared (NestJS
// constructor injection). JSX elements count as calls to their component. Shared by the
// function-calls view and the screens view.

export const SOURCE = /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/;
const MAX_FILES = 4000;
const MAX_FILE_BYTES = 256_000;
const HTTP_DECORATORS = /^(Get|Post|Put|Patch|Delete|Options|Head|All)$/;
const HTTP_EXPORTS = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/;

// 'value' is a top-level constant that holds functions without being one, such as a route
// definition object; it carries references but isn't drawn as a function.
export type Kind = 'function' | 'method' | 'component' | 'handler' | 'value';

// When code runs in a UI: as the screen loads, or in response to the user.
export type Trigger = 'load' | 'action';

export interface Decl {
  id: string;
  file: string;
  key: string; // "fn", "Class.method", or "object.method"
  kind: Kind;
  line: number;
  start: number;
  end: number;
}

type Target =
  | { kind: 'name'; name: string } // a local or imported binding
  | { kind: 'member'; object: string; member: string } // ns.fn(), Class.staticFn()
  | { kind: 'this'; className: string; member: string }
  | { kind: 'thisProp'; className: string; prop: string; member: string };

export type RefLabel = '' | 'renders' | 'uses';

interface Reference {
  from: string; // decl id
  target: Target;
  label: RefLabel;
  pos: number;
}

interface Region {
  start: number;
  end: number;
  trigger: Trigger;
}

export interface FileInfo {
  path: string;
  source: ts.SourceFile;
  decls: Map<string, Decl>;
  // Classes and object literals whose members are declared as "Owner.member".
  owners: Set<string>;
  // Local binding -> what it imports: a file and an export name ("default", or "*" for a
  // namespace import).
  imports: Map<string, { file: string; name: string }>;
  // Export name -> local name.
  exports: Map<string, string>;
  reexports: Map<string, { file: string; name: string }>;
  starExports: string[];
  // Class -> property -> declared type name, for `this.prop.method()`.
  propTypes: Map<string, Map<string, string>>;
  references: Reference[];
  // Spans of code that run on load or on a user action, innermost last.
  regions: Region[];
}

export interface CallRef {
  from: Decl;
  to: Decl;
  label: RefLabel;
  trigger?: Trigger;
}

// A resolved reference at a position in a file.
export interface SpanRef {
  pos: number;
  to: Decl;
  label: RefLabel;
  trigger?: Trigger;
}

const scriptKind = (path: string) =>
  path.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : path.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : /\.(js|mjs|cjs)$/.test(path)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);

const decoratorNames = (node: ts.Node) =>
  (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []).map((d) =>
    ts.isCallExpression(d.expression)
      ? d.expression.expression.getText()
      : d.expression.getText(),
  );

// The type name a parameter or property is declared with: `AnalysesService`, or the last
// part of `ns.Type`.
const typeName = (type: ts.TypeNode | undefined) =>
  type && ts.isTypeReferenceNode(type)
    ? type.typeName.getText().split('.').pop()
    : undefined;

const isFunctionLike = (
  node: ts.Node | undefined,
): node is ts.ArrowFunction | ts.FunctionExpression =>
  !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));

// `memo(() => ...)`, `forwardRef(function X() {})`: the function inside a wrapper call.
const unwrap = (node: ts.Expression | undefined): ts.Node | undefined => {
  if (!node) return undefined;
  if (isFunctionLike(node)) return node;
  if (ts.isCallExpression(node)) return node.arguments.find(isFunctionLike);
  return undefined;
};

// `lazy(() => import('./Orders'))`, `dynamic(() => import('./Orders'))`: the module a
// lazily loaded component comes from.
const LAZY =
  /^(?:React\.)?(?:lazy|loadable|dynamic|lazyWithPreload|defineAsyncComponent)\s*\(\s*(?:async\s*)?\(\s*\)\s*=>\s*import\(\s*['"`]([^'"`]+)['"`]\s*\)\s*\)$/;

const calleeName = (call: ts.CallExpression) => {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
};

// Hooks and options whose functions run as a screen loads, or when the user acts.
const LOAD_CALLS =
  /^(useEffect|useLayoutEffect|useQuery|useQueries|useSuspenseQuery|useInfiniteQuery|useSuspenseInfiniteQuery|useSWR|useSWRInfinite|useSWRImmutable|useFetch|useAsync|useAsyncEffect|createResource|onMounted|onMount|getServerSideProps|getStaticProps)$/;
const ACTION_CALLS = /^(useMutation|useSWRMutation|useTransition)$/;
const LOAD_PROPS = /^(queryFn|loader|clientLoader|beforeLoad|load)$/;
const ACTION_PROPS = /^(mutationFn|action|clientAction)$/;
// A local function a component defines, such as `const save = async () => ...`, runs when
// something calls it, which in a component is nearly always an event, unless its name says
// it computes something for the render.
const RENDER_HELPER =
  /^(use|render|get|format|to|is|has|can|should|compute|calc|map|filter|sort|build|make|create)[A-Z_]?/;
const isLocalCallback = (node: ts.Expression | undefined) =>
  !!node &&
  (isFunctionLike(node) ||
    (ts.isCallExpression(node) &&
      calleeName(node) === 'useCallback' &&
      isFunctionLike(node.arguments[0])));

function findRegions(source: ts.SourceFile) {
  const regions: Region[] = [];
  const add = (node: ts.Node, trigger: Trigger) => {
    regions.push({ start: node.getStart(source), end: node.getEnd(), trigger });
    return true;
  };
  // `depth` counts the functions and objects around a node; `inside` is whether a region
  // already covers it, so a callback defined inside an effect stays "on load".
  const visit = (node: ts.Node, depth: number, inside: boolean) => {
    let added = false;
    if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(source);
      if (/^on[A-Z]/.test(name) || name === 'action' || name === 'formAction')
        added = add(node.initializer, 'action');
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && LOAD_CALLS.test(name)) added = add(node, 'load');
      else if (name && ACTION_CALLS.test(name)) added = add(node, 'action');
    } else if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      depth > 0
    ) {
      if (LOAD_PROPS.test(node.name.text))
        added = add(node.initializer, 'load');
      else if (ACTION_PROPS.test(node.name.text))
        added = add(node.initializer, 'action');
    } else if (
      ts.isVariableDeclaration(node) &&
      depth > 0 &&
      !inside &&
      ts.isIdentifier(node.name) &&
      !RENDER_HELPER.test(node.name.text) &&
      isLocalCallback(node.initializer)
    ) {
      added = add(node.initializer!, 'action');
    } else if (
      ts.isFunctionDeclaration(node) &&
      depth > 0 &&
      !inside &&
      node.name &&
      !RENDER_HELPER.test(node.name.text)
    ) {
      added = add(node, 'action');
    }
    const inner =
      ts.isFunctionLike(node) || ts.isObjectLiteralExpression(node)
        ? depth + 1
        : depth;
    ts.forEachChild(node, (child) => visit(child, inner, inside || added));
  };
  ts.forEachChild(source, (child) => visit(child, 0, false));
  // Innermost last, so a lookup can take the last region that contains a position.
  return regions.sort((a, b) => a.start - b.start || b.end - a.end);
}

export function parseFile(
  path: string,
  text: string,
  files: Set<string>,
): FileInfo {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  );
  const info: FileInfo = {
    path,
    source,
    decls: new Map(),
    owners: new Set(),
    imports: new Map(),
    exports: new Map(),
    reexports: new Map(),
    starExports: [],
    propTypes: new Map(),
    references: [],
    regions: findRegions(source),
  };
  const resolve = (spec: string) => resolveJsImport(path, spec, files);
  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const isJsx = /\.[jt]sx$/.test(path);

  // `anchor` is where the declaration's line is read from; `span` is the code it covers.
  const declare = (key: string, anchor: ts.Node, kind: Kind, span = anchor) => {
    const decl: Decl = {
      id: `fn:${path}#${key}`,
      file: path,
      key,
      kind,
      line: lineOf(anchor),
      start: span.getStart(source),
      end: span.getEnd(),
    };
    info.decls.set(key, decl);
    return decl;
  };
  const functionKind = (name: string): Kind =>
    isJsx && /^[A-Z]/.test(name) ? 'component' : 'function';

  // Records what a function body calls, renders, and refers to.
  const walk = (body: ts.Node, from: Decl, className?: string) => {
    const callees = new Set<ts.Node>();
    const add = (target: Target, label: RefLabel, node: ts.Node) =>
      info.references.push({
        from: from.id,
        target,
        label,
        pos: node.getStart(source),
      });
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        callees.add(callee);
        if (ts.isIdentifier(callee))
          add({ kind: 'name', name: callee.text }, '', node);
        else if (ts.isPropertyAccessExpression(callee)) {
          const object = callee.expression;
          const member = callee.name.text;
          callees.add(object);
          if (ts.isIdentifier(object))
            add({ kind: 'member', object: object.text, member }, '', node);
          else if (object.kind === ts.SyntaxKind.ThisKeyword && className) {
            add({ kind: 'this', className, member }, '', node);
          } else if (
            ts.isPropertyAccessExpression(object) &&
            object.expression.kind === ts.SyntaxKind.ThisKeyword &&
            className
          ) {
            add(
              { kind: 'thisProp', className, prop: object.name.text, member },
              '',
              node,
            );
          }
        }
      } else if (
        ts.isJsxOpeningElement(node) ||
        ts.isJsxSelfClosingElement(node)
      ) {
        if (ts.isIdentifier(node.tagName) && /^[A-Z]/.test(node.tagName.text)) {
          callees.add(node.tagName);
          add({ kind: 'name', name: node.tagName.text }, 'renders', node);
        }
      } else if (
        ts.isIdentifier(node) &&
        !callees.has(node) &&
        !(
          ts.isPropertyAccessExpression(node.parent) &&
          node.parent.name === node
        ) &&
        !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
        !ts.isImportSpecifier(node.parent)
      ) {
        // A function passed as a value: `queryFn: listProjects`, `onClick={save}`.
        add({ kind: 'name', name: node.text }, 'uses', node);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(body, visit);
  };

  for (const statement of source.statements) {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);

    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const file = resolve(statement.moduleSpecifier.text);
      const clause = statement.importClause;
      if (!file || !clause) continue;
      if (clause.name)
        info.imports.set(clause.name.text, { file, name: 'default' });
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        info.imports.set(bindings.name.text, { file, name: '*' });
      } else if (bindings) {
        for (const el of bindings.elements) {
          info.imports.set(el.name.text, {
            file,
            name: (el.propertyName ?? el.name).text,
          });
        }
      }
    } else if (ts.isExportDeclaration(statement)) {
      const file =
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
          ? resolve(statement.moduleSpecifier.text)
          : undefined;
      const clause = statement.exportClause;
      if (statement.moduleSpecifier && !file) continue;
      if (!clause) {
        if (file) info.starExports.push(file);
      } else if (ts.isNamedExports(clause)) {
        for (const el of clause.elements) {
          const local = (el.propertyName ?? el.name).text;
          if (file) info.reexports.set(el.name.text, { file, name: local });
          else info.exports.set(el.name.text, local);
        }
      }
    } else if (
      ts.isExportAssignment(statement) &&
      ts.isIdentifier(statement.expression)
    ) {
      info.exports.set('default', statement.expression.text);
    } else if (ts.isFunctionDeclaration(statement) && statement.body) {
      const name = statement.name?.text ?? 'default';
      const kind: Kind =
        exported && HTTP_EXPORTS.test(name) ? 'handler' : functionKind(name);
      const decl = declare(name, statement, kind);
      if (exported) info.exports.set(isDefault ? 'default' : name, name);
      walk(statement.body, decl);
    } else if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const name = d.name.text;
        const lazy = LAZY.exec(d.initializer.getText(source));
        const lazyFile = lazy && resolve(lazy[1]!);
        if (lazyFile) {
          info.imports.set(name, { file: lazyFile, name: 'default' });
          continue;
        }
        if (exported) info.exports.set(name, name);
        const fn = unwrap(d.initializer);
        if (fn) {
          const kind: Kind =
            exported && HTTP_EXPORTS.test(name)
              ? 'handler'
              : functionKind(name);
          walk(fn, declare(name, d, kind));
          continue;
        }
        // `export const ordersApi = { list: () => ... }`: each function is `ordersApi.list`.
        if (ts.isObjectLiteralExpression(d.initializer)) {
          for (const p of d.initializer.properties) {
            const fn = ts.isMethodDeclaration(p)
              ? p
              : ts.isPropertyAssignment(p)
                ? unwrap(p.initializer)
                : undefined;
            if (!fn || !p.name || !ts.isIdentifier(p.name)) continue;
            info.owners.add(name);
            walk(fn, declare(`${name}.${p.name.text}`, p, 'function'));
          }
        }
        // Whatever else the constant holds (route definitions, configs) still refers to
        // functions, e.g. `createFileRoute('/')({ component: Home })`. An object of
        // functions isn't one, or using one method would reach all of them.
        if (!info.owners.has(name))
          walk(d.initializer, declare(name, d, 'value'));
      }
    } else if (ts.isClassDeclaration(statement)) {
      const className = statement.name?.text ?? 'default';
      info.owners.add(className);
      if (exported)
        info.exports.set(isDefault ? 'default' : className, className);
      const props = new Map<string, string>();
      info.propTypes.set(className, props);
      for (const member of statement.members) {
        if (ts.isConstructorDeclaration(member)) {
          // `constructor(private readonly orders: OrdersService)` declares `this.orders`.
          for (const p of member.parameters) {
            const type = typeName(p.type);
            const isProperty = (ts.getModifiers(p) ?? []).some((m) =>
              [
                ts.SyntaxKind.PrivateKeyword,
                ts.SyntaxKind.PublicKeyword,
                ts.SyntaxKind.ProtectedKeyword,
                ts.SyntaxKind.ReadonlyKeyword,
              ].includes(m.kind),
            );
            if (isProperty && type && ts.isIdentifier(p.name))
              props.set(p.name.text, type);
          }
        } else if (
          ts.isPropertyDeclaration(member) &&
          ts.isIdentifier(member.name)
        ) {
          const type = typeName(member.type);
          if (type) props.set(member.name.text, type);
          const fn = unwrap(member.initializer);
          if (fn)
            walk(
              fn,
              declare(`${className}.${member.name.text}`, member, 'method'),
              className,
            );
        } else if (
          ts.isMethodDeclaration(member) &&
          member.body &&
          ts.isIdentifier(member.name)
        ) {
          const handler = decoratorNames(member).some((n) =>
            HTTP_DECORATORS.test(n),
          );
          // Anchored on the name, so the line skips past any decorators.
          const decl = declare(
            `${className}.${member.name.text}`,
            member.name,
            handler ? 'handler' : 'method',
            member,
          );
          walk(member.body, decl, className);
        }
      }
    }
  }
  return info;
}

export interface CallGraph {
  files: Map<string, FileInfo>;
  texts: Map<string, string>;
  // Every resolved reference, one per (from, to, label, trigger).
  refs: CallRef[];
  // What a name visible in a file refers to, following imports and re-exports.
  resolveName(file: string, name: string): Decl | undefined;
  // What a file exports under a name ("default" for its default export).
  exportOf(file: string, name: string): Decl | undefined;
  // The resolved references made by the code between two positions of a file.
  refsIn(file: string, start: number, end: number): SpanRef[];
  // The innermost function containing a position in a file.
  declAt(file: string, pos: number): Decl | undefined;
  // Whether the code at a position runs on load or on an action, if a hook, handler, or
  // event prop around it says so.
  triggerAt(file: string, pos: number): Trigger | undefined;
}

export async function buildCallGraph(
  repoDir: string,
  paths: string[],
): Promise<CallGraph> {
  const sources = paths
    .filter((p) => SOURCE.test(p) && !p.endsWith('.d.ts') && !isTestFile(p))
    .slice(0, MAX_FILES);
  const fileSet = new Set(paths);
  const files = new Map<string, FileInfo>();
  const texts = new Map<string, string>();
  for (const path of sources) {
    const text = await readText(repoDir, path, MAX_FILE_BYTES).catch(
      () => undefined,
    );
    if (!text) continue;
    texts.set(path, text);
    try {
      files.set(path, parseFile(path, text, fileSet));
    } catch {
      // A file the parser can't handle only loses its own calls.
    }
  }

  // What an export of a file refers to: a function or class declared somewhere, following
  // re-exports through barrel files.
  const resolveExport = (
    file: string,
    name: string,
    depth = 0,
  ): { file: FileInfo; local: string } | undefined => {
    const info = files.get(file);
    if (!info || depth > 5) return undefined;
    const local = info.exports.get(name);
    if (local !== undefined) {
      // `export default Orders` where Orders is itself imported.
      const imported = info.imports.get(local);
      if (!info.decls.has(local) && imported && imported.name !== '*')
        return resolveExport(imported.file, imported.name, depth + 1);
      return { file: info, local };
    }
    const re = info.reexports.get(name);
    if (re) return resolveExport(re.file, re.name, depth + 1);
    for (const star of info.starExports) {
      const found = resolveExport(star, name, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  // A binding visible in a file: its own declaration or class, or what it imports.
  const binding = (info: FileInfo, name: string) => {
    if (info.decls.has(name) || info.owners.has(name))
      return { file: info, local: name };
    const imported = info.imports.get(name);
    if (!imported || imported.name === '*') return undefined;
    return resolveExport(imported.file, imported.name);
  };
  const declOf = (file: FileInfo, key: string) => file.decls.get(key);
  const member = (
    owner: { file: FileInfo; local: string } | undefined,
    name: string,
  ) =>
    owner && owner.file.owners.has(owner.local)
      ? declOf(owner.file, `${owner.local}.${name}`)
      : undefined;

  const resolveTarget = (info: FileInfo, target: Target): Decl | undefined => {
    switch (target.kind) {
      case 'name': {
        const found = binding(info, target.name);
        return found && declOf(found.file, found.local);
      }
      case 'member': {
        const imported = info.imports.get(target.object);
        if (imported?.name === '*') {
          const found = resolveExport(imported.file, target.member);
          return found && declOf(found.file, found.local);
        }
        return member(binding(info, target.object), target.member);
      }
      case 'this':
        return declOf(info, `${target.className}.${target.member}`);
      case 'thisProp': {
        const type = info.propTypes.get(target.className)?.get(target.prop);
        return type ? member(binding(info, type), target.member) : undefined;
      }
    }
  };

  const triggerAt = (file: string, pos: number) => {
    const regions = files.get(file)?.regions ?? [];
    let found: Trigger | undefined;
    for (const r of regions) {
      if (r.start > pos) break;
      if (pos < r.end) found = r.trigger;
    }
    return found;
  };

  const refs = new Map<string, CallRef>();
  const spanRefs = new Map<string, SpanRef[]>();
  for (const info of files.values()) {
    const inFile: SpanRef[] = [];
    spanRefs.set(info.path, inFile);
    const byId = new Map([...info.decls.values()].map((d) => [d.id, d]));
    for (const ref of info.references) {
      const to = resolveTarget(info, ref.target);
      const from = byId.get(ref.from);
      if (!to || !from || to.id === from.id) continue;
      const trigger = triggerAt(info.path, ref.pos);
      inFile.push({
        pos: ref.pos,
        to,
        label: ref.label,
        ...(trigger && { trigger }),
      });
      const key = `${from.id}->${to.id}:${ref.label}:${trigger ?? ''}`;
      if (!refs.has(key))
        refs.set(key, {
          from,
          to,
          label: ref.label,
          ...(trigger && { trigger }),
        });
    }
  }

  return {
    files,
    texts,
    refs: [...refs.values()],
    resolveName: (file, name) => {
      const info = files.get(file);
      const found = info && binding(info, name);
      return found && declOf(found.file, found.local);
    },
    exportOf: (file, name) => {
      const found = resolveExport(file, name);
      return found && declOf(found.file, found.local);
    },
    refsIn: (file, start, end) =>
      (spanRefs.get(file) ?? []).filter((r) => r.pos >= start && r.pos < end),
    declAt: (file, pos) => {
      let best: Decl | undefined;
      for (const d of files.get(file)?.decls.values() ?? []) {
        if (d.start <= pos && pos < d.end && (!best || d.start >= best.start))
          best = d;
      }
      return best;
    },
    triggerAt,
  };
}
