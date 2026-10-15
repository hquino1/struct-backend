import ts from 'typescript';
import {
  componentLocator,
  isTestFile,
  readText,
  resolveJsImport,
} from '../../repo-digest.js';
import type {
  ViewEdge,
  ViewExtractor,
  ViewGraph,
  ViewNode,
} from '../view-graph.js';

// Which functions call which, for JavaScript and TypeScript. Each file is parsed for its
// syntax only (no type-checking), and calls are resolved through what the syntax shows:
// imports and re-exports, same-file functions, `this.method()`, and `this.service.method()`
// where the property's type is declared (NestJS constructor injection). JSX elements count
// as calls to their component. The view keeps the most connected functions, favouring
// calls that cross files and components.

const SOURCE = /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/;
const MAX_FILES = 4000;
const MAX_FILE_BYTES = 256_000;
const MAX_NODES = 120;
const HTTP_DECORATORS = /^(Get|Post|Put|Patch|Delete|Options|Head|All)$/;
const HTTP_EXPORTS = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/;

type Kind = 'function' | 'method' | 'component' | 'handler';

interface Decl {
  id: string;
  file: string;
  key: string; // "fn" or "Class.method"
  kind: Kind;
  line: number;
}

type Target =
  | { kind: 'name'; name: string } // a local or imported binding
  | { kind: 'member'; object: string; member: string } // ns.fn(), Class.staticFn()
  | { kind: 'this'; className: string; member: string }
  | { kind: 'thisProp'; className: string; prop: string; member: string };

interface Reference {
  from: string; // decl id
  target: Target;
  label: '' | 'renders' | 'uses';
}

interface FileInfo {
  path: string;
  decls: Map<string, Decl>;
  classes: Set<string>;
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

function parseFile(path: string, text: string, files: Set<string>): FileInfo {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  );
  const info: FileInfo = {
    path,
    decls: new Map(),
    classes: new Set(),
    imports: new Map(),
    exports: new Map(),
    reexports: new Map(),
    starExports: [],
    propTypes: new Map(),
    references: [],
  };
  const resolve = (spec: string) => resolveJsImport(path, spec, files);
  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const isJsx = /\.[jt]sx$/.test(path);

  const declare = (key: string, node: ts.Node, kind: Kind) => {
    const decl: Decl = {
      id: `fn:${path}#${key}`,
      file: path,
      key,
      kind,
      line: lineOf(node),
    };
    info.decls.set(key, decl);
    return decl;
  };
  const functionKind = (name: string): Kind =>
    isJsx && /^[A-Z]/.test(name) ? 'component' : 'function';

  // Records what a function body calls, renders, and refers to.
  const walk = (body: ts.Node, from: Decl, className?: string) => {
    const callees = new Set<ts.Node>();
    const add = (target: Target, label: Reference['label']) =>
      info.references.push({ from: from.id, target, label });
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        callees.add(callee);
        if (ts.isIdentifier(callee))
          add({ kind: 'name', name: callee.text }, '');
        else if (ts.isPropertyAccessExpression(callee)) {
          const object = callee.expression;
          const member = callee.name.text;
          callees.add(object);
          if (ts.isIdentifier(object))
            add({ kind: 'member', object: object.text, member }, '');
          else if (object.kind === ts.SyntaxKind.ThisKeyword && className) {
            add({ kind: 'this', className, member }, '');
          } else if (
            ts.isPropertyAccessExpression(object) &&
            object.expression.kind === ts.SyntaxKind.ThisKeyword &&
            className
          ) {
            add(
              { kind: 'thisProp', className, prop: object.name.text, member },
              '',
            );
          }
        }
      } else if (
        ts.isJsxOpeningElement(node) ||
        ts.isJsxSelfClosingElement(node)
      ) {
        if (ts.isIdentifier(node.tagName) && /^[A-Z]/.test(node.tagName.text)) {
          callees.add(node.tagName);
          add({ kind: 'name', name: node.tagName.text }, 'renders');
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
        add({ kind: 'name', name: node.text }, 'uses');
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
        const fn = unwrap(d.initializer);
        if (!ts.isIdentifier(d.name) || !fn) continue;
        const name = d.name.text;
        const kind: Kind =
          exported && HTTP_EXPORTS.test(name) ? 'handler' : functionKind(name);
        const decl = declare(name, d, kind);
        if (exported) info.exports.set(name, name);
        walk(fn, decl);
      }
    } else if (ts.isClassDeclaration(statement)) {
      const className = statement.name?.text ?? 'default';
      info.classes.add(className);
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
          );
          walk(member.body, decl, className);
        }
      }
    }
  }
  return info;
}

export const callsExtractor: ViewExtractor = {
  view: 'calls',
  applies: (paths) => paths.some((p) => SOURCE.test(p) && !p.endsWith('.d.ts')),

  async extract(context) {
    const sources = context.paths
      .filter((p) => SOURCE.test(p) && !p.endsWith('.d.ts') && !isTestFile(p))
      .slice(0, MAX_FILES);
    const fileSet = new Set(context.paths);
    const files = new Map<string, FileInfo>();
    for (const path of sources) {
      const text = await readText(context.repoDir, path, MAX_FILE_BYTES).catch(
        () => undefined,
      );
      if (!text) continue;
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
      if (local !== undefined) return { file: info, local };
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
      if (info.decls.has(name) || info.classes.has(name))
        return { file: info, local: name };
      const imported = info.imports.get(name);
      if (!imported || imported.name === '*') return undefined;
      return resolveExport(imported.file, imported.name);
    };
    const declOf = (file: FileInfo, key: string) => file.decls.get(key);
    const method = (
      owner: { file: FileInfo; local: string } | undefined,
      member: string,
    ) =>
      owner && owner.file.classes.has(owner.local)
        ? declOf(owner.file, `${owner.local}.${member}`)
        : undefined;

    const resolveTarget = (
      info: FileInfo,
      target: Target,
    ): Decl | undefined => {
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
          return method(binding(info, target.object), target.member);
        }
        case 'this':
          return declOf(info, `${target.className}.${target.member}`);
        case 'thisProp': {
          const type = info.propTypes.get(target.className)?.get(target.prop);
          return type ? method(binding(info, type), target.member) : undefined;
        }
      }
    };

    // Resolve, then keep one edge per (caller, callee); a call outranks a render or a use.
    const rank = { '': 2, renders: 1, uses: 0 } as const;
    const edges = new Map<string, ViewEdge>();
    const decls = new Map<string, Decl>();
    for (const info of files.values()) {
      const byId = new Map([...info.decls.values()].map((d) => [d.id, d]));
      for (const ref of info.references) {
        const target = resolveTarget(info, ref.target);
        const from = byId.get(ref.from);
        if (!target || !from || target.id === from.id) continue;
        const key = `${from.id}->${target.id}`;
        const existing = edges.get(key);
        if (
          existing &&
          rank[existing.label as keyof typeof rank] >= rank[ref.label]
        )
          continue;
        edges.set(key, { from: from.id, to: target.id, label: ref.label });
        decls.set(from.id, from);
        decls.set(target.id, target);
      }
    }

    // Keep the functions with the most significant connections.
    const locate = componentLocator(context.components);
    const componentOf = new Map(
      [...decls.values()].map((d) => [d.id, locate(d.file)]),
    );
    const score = new Map<string, number>();
    for (const { from, to } of edges.values()) {
      const a = decls.get(from)!;
      const b = decls.get(to)!;
      const weight =
        componentOf.get(from) !== componentOf.get(to)
          ? 3
          : a.file !== b.file
            ? 2
            : 1;
      score.set(from, (score.get(from) ?? 0) + weight);
      score.set(to, (score.get(to) ?? 0) + weight);
    }
    const kept = new Set(
      [...score]
        .sort(([, a], [, b]) => b - a)
        .slice(0, MAX_NODES)
        .map(([id]) => id),
    );

    const names = new Map(context.components.map((c) => [c.id, c.name]));
    const nodes: ViewNode[] = [...kept].map((id) => {
      const d = decls.get(id)!;
      const componentId = componentOf.get(id);
      return {
        id,
        name: d.kind === 'component' ? `<${d.key}>` : `${d.key}()`,
        kind: d.kind,
        detail: `${d.file}:${d.line}`,
        group: (componentId && names.get(componentId)) || d.file.split('/')[0]!,
        path: d.file,
        ...(componentId && { componentId }),
      };
    });
    return {
      nodes,
      edges: [...edges.values()].filter(
        (e) => kept.has(e.from) && kept.has(e.to),
      ),
    } satisfies ViewGraph;
  },
};
