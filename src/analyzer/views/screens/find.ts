import ts from 'typescript';
import type { CallGraph, Decl } from '../calls/graph.js';

// The screens of an app: the pages a router can show, each with the code that draws it.
// File-based routers (Next.js, Expo Router) are read from paths; routers declared in code
// (React Router, TanStack Router, react-navigation) from the syntax of their route
// definitions.

// Where a screen's code starts: a component, or a span of code such as an inline
// component or loader inside a route definition.
export type Root =
  | { kind: 'decl'; decl: Decl }
  | { kind: 'span'; file: string; start: number; end: number };

export interface Screen {
  route: string;
  // How to show it when the route alone doesn't say, e.g. a pathless layout.
  name?: string;
  file: string;
  line: number;
  kind: 'page' | 'layout';
  framework: string;
  roots: Root[];
}

const SOURCE = /\.[cm]?[jt]sx?$/;
const NEXT_CONFIG = /(^|\/)next\.config\.[cm]?[jt]s$/;
const NEXT_APP = /^(.*?(?:^|\/))app\/(?:(.*)\/)?(page|layout)\.[jt]sx?$/;
const NEXT_PAGES = /^(.*?(?:^|\/))pages\/(.+)\.[jt]sx?$/;
const EXPO_ROOT = /^(.*?(?:^|\/))app\/_layout\.[jt]sx?$/;
const ROUTE_HINT =
  /<Route\b|\.Screen\b|create(?:Lazy)?FileRoute|createRootRoute|\bpath\s*:/;

// `/orders/[id]`, `/(shop)/cart`, `$id`, `_auth` all become plain route paths.
export function routePath(segments: string[]) {
  const kept = segments
    .filter(
      (s) =>
        s &&
        s !== 'index' &&
        !/^\(.*\)$/.test(s) && // Next and Expo route groups
        !s.startsWith('@') && // Next parallel routes
        !(s.startsWith('_') && s.length > 1), // TanStack pathless layouts
    )
    .map((s) =>
      s
        .replace(/^\[\[?\.\.\.(\w+)\]?\]$/, ':$1')
        .replace(/^\[(\w+)\]$/, ':$1')
        .replace(/^\$$/, ':splat')
        .replace(/^\$(\w+)$/, ':$1')
        .replace(/^\{-?\$(\w+)\}$/, ':$1'),
    );
  return `/${kept.join('/')}`;
}

const joinRoute = (parent: string, path: string) =>
  path.startsWith('/')
    ? routePath(path.split('/'))
    : routePath([...parent.split('/'), ...path.split('/')]);

function fileScreens(paths: string[], graph: CallGraph): Screen[] {
  const sources = paths.filter((p) => SOURCE.test(p) && graph.files.has(p));
  const usesNext =
    paths.some((p) => NEXT_CONFIG.test(p)) ||
    [...graph.texts.values()].some((t) => /from\s+['"]next\//.test(t));
  const expoRoots = paths.flatMap((p) => EXPO_ROOT.exec(p)?.[1] ?? []);
  // The page's default export, or else the components the file declares.
  const rootsOf = (file: string): Root[] => {
    const main = graph.exportOf(file, 'default');
    if (main) return [{ kind: 'decl', decl: main }];
    const decls = [...(graph.files.get(file)?.decls.values() ?? [])];
    const components = decls.filter((d) => d.kind === 'component');
    return (components.length ? components : decls).map((decl) => ({
      kind: 'decl',
      decl,
    }));
  };
  const screen = (
    file: string,
    route: string,
    kind: Screen['kind'],
    framework: string,
  ): Screen => ({
    route,
    file,
    line: 1,
    kind,
    framework,
    roots: rootsOf(file),
  });

  const screens: Screen[] = [];
  for (const file of sources) {
    const expo = expoRoots.find((root) => file.startsWith(`${root}app/`));
    if (expo !== undefined) {
      const rel = file.slice(expo.length + 4).replace(SOURCE, '');
      const name = rel.split('/').pop()!;
      if (name.startsWith('+')) continue; // +html, +not-found, +api
      const layout = name === '_layout';
      const segments = rel.split('/').slice(0, layout ? -1 : undefined);
      screens.push(
        screen(
          file,
          routePath(segments),
          layout ? 'layout' : 'page',
          'Expo Router',
        ),
      );
      continue;
    }
    if (!usesNext) continue;
    const app = NEXT_APP.exec(file);
    if (app) {
      screens.push(
        screen(
          file,
          routePath((app[2] ?? '').split('/')),
          app[3] === 'layout' ? 'layout' : 'page',
          'Next.js',
        ),
      );
      continue;
    }
    const pages = NEXT_PAGES.exec(file);
    if (pages && !/^(api\/|_document$|_error$)/.test(pages[2]!)) {
      const layout = pages[2] === '_app';
      screens.push(
        screen(
          file,
          layout ? '/' : routePath(pages[2]!.split('/')),
          layout ? 'layout' : 'page',
          'Next.js',
        ),
      );
    }
  }
  return screens;
}

const propName = (p: ts.ObjectLiteralElementLike) =>
  p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
    ? p.name.text
    : undefined;

const stringValue = (node: ts.Node | undefined) =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;

function codeScreens(graph: CallGraph): Screen[] {
  const screens: Screen[] = [];
  for (const [file, info] of graph.files) {
    const text = graph.texts.get(file);
    if (!text || !ROUTE_HINT.test(text)) continue;
    const source = info.source;
    const lineOf = (node: ts.Node) =>
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

    // The roots a route names: components it renders (`element={<Orders />}`), a component
    // it names (`component: Orders`), or an inline function, read as a span.
    const rootsIn = (node: ts.Node | undefined): Root[] => {
      if (!node) return [];
      if (ts.isJsxExpression(node)) return rootsIn(node.expression);
      if (ts.isIdentifier(node)) {
        const decl = graph.resolveName(file, node.text);
        return decl ? [{ kind: 'decl', decl }] : [];
      }
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
        return [
          {
            kind: 'span',
            file,
            start: node.getStart(source),
            end: node.getEnd(),
          },
        ];
      const roots: Root[] = [];
      const visit = (n: ts.Node) => {
        if (
          (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) &&
          ts.isIdentifier(n.tagName) &&
          /^[A-Z]/.test(n.tagName.text)
        ) {
          const decl = graph.resolveName(file, n.tagName.text);
          if (decl) roots.push({ kind: 'decl', decl });
        }
        ts.forEachChild(n, visit);
      };
      visit(node);
      return roots;
    };

    const add = (
      node: ts.Node,
      route: string,
      kind: Screen['kind'],
      framework: string,
      roots: Root[],
      name?: string,
    ) => {
      if (roots.length)
        screens.push({
          route,
          file,
          line: lineOf(node),
          kind,
          framework,
          roots,
          ...(name && { name }),
        });
    };

    const visit = (node: ts.Node, parent: string) => {
      // <Route path="orders/:id" element={<Order />} />, <Stack.Screen name="Orders" component={Orders} />
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        const tag = opening.tagName.getText(source);
        const navigator = tag.endsWith('.Screen');
        if (tag === 'Route' || navigator) {
          const attrs = new Map<string, ts.JsxAttribute>();
          for (const a of opening.attributes.properties) {
            if (ts.isJsxAttribute(a)) attrs.set(a.name.getText(source), a);
          }
          const value = (name: string) => {
            const init = attrs.get(name)?.initializer;
            return (
              stringValue(init) ??
              (init && ts.isJsxExpression(init)
                ? stringValue(init.expression)
                : undefined)
            );
          };
          const path = value(navigator ? 'name' : 'path');
          const route = navigator
            ? (path ?? parent)
            : path !== undefined
              ? joinRoute(parent, path)
              : parent;
          const roots = ['element', 'component', 'Component', 'render'].flatMap(
            (name) => rootsIn(attrs.get(name)?.initializer),
          );
          const nested =
            ts.isJsxElement(node) &&
            node.children.some(
              (c) =>
                (ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) &&
                /^Route$|\.Screen$/.test(
                  (ts.isJsxElement(c) ? c.openingElement : c).tagName.getText(
                    source,
                  ),
                ),
            );
          add(
            node,
            route,
            nested || (!path && !attrs.has('index') && !navigator)
              ? 'layout'
              : 'page',
            navigator ? 'React Navigation' : 'React Router',
            roots,
          );
          if (ts.isJsxElement(node))
            node.children.forEach((c) => visit(c, route));
          return;
        }
      }

      // createFileRoute('/orders/$id')({ component: Order, loader: ... })
      if (
        ts.isCallExpression(node) &&
        ts.isCallExpression(node.expression) &&
        /^create(Lazy)?FileRoute$/.test(
          node.expression.expression.getText(source),
        )
      ) {
        const id = stringValue(node.expression.arguments[0]) ?? '/';
        const options = node.arguments[0];
        if (options && ts.isObjectLiteralExpression(options)) {
          const last = id.split('/').filter(Boolean).pop() ?? '';
          const pathless = last.startsWith('_');
          add(
            node,
            routePath(id.split('/')),
            pathless ? 'layout' : 'page',
            'TanStack Router',
            routeOptionRoots(options),
            pathless ? `${id} layout` : undefined,
          );
        }
        return;
      }
      if (
        ts.isCallExpression(node) &&
        /^createRootRoute(WithContext)?$/.test(
          node.expression
            .getText(source)
            .replace(/<.*>\(\)$/, '')
            .replace(/\(\)$/, ''),
        )
      ) {
        const options = node.arguments[0];
        if (options && ts.isObjectLiteralExpression(options))
          add(
            node,
            '/',
            'layout',
            'TanStack Router',
            routeOptionRoots(options),
            'Root layout',
          );
        return;
      }

      // { path: 'orders', element: <Orders />, children: [...] } in a route config array.
      if (ts.isObjectLiteralExpression(node)) {
        const props = new Map(
          node.properties.flatMap((p) => {
            const name = propName(p);
            return name && ts.isPropertyAssignment(p)
              ? [[name, p.initializer]]
              : [];
          }),
        );
        const path = stringValue(props.get('path'));
        const shows = ['element', 'component', 'Component'].some((k) =>
          props.has(k),
        );
        const children = props.get('children');
        if ((path !== undefined || props.has('index')) && (shows || children)) {
          const route = path !== undefined ? joinRoute(parent, path) : parent;
          add(
            node,
            route,
            children ? 'layout' : 'page',
            props.has('getParentRoute') ? 'TanStack Router' : 'React Router',
            routeOptionRoots(node),
          );
          if (children) visit(children, route);
          return;
        }
      }
      ts.forEachChild(node, (child) => visit(child, parent));
    };

    // What a route definition object runs: its component, and loaders that fetch for it.
    function routeOptionRoots(options: ts.ObjectLiteralExpression) {
      return options.properties.flatMap((p) => {
        const name = propName(p);
        if (!name) return [];
        if (
          ts.isMethodDeclaration(p) &&
          /^(loader|beforeLoad|clientLoader)$/.test(name)
        )
          return [
            {
              kind: 'span',
              file,
              start: p.getStart(source),
              end: p.getEnd(),
            } as Root,
          ];
        if (!ts.isPropertyAssignment(p)) return [];
        if (/^(element|component|Component)$/.test(name))
          return rootsIn(p.initializer);
        if (/^(loader|beforeLoad|clientLoader)$/.test(name))
          return rootsIn(p.initializer);
        return [];
      });
    }

    visit(source, '/');
  }
  return screens;
}

export function findScreens(paths: string[], graph: CallGraph) {
  return [...fileScreens(paths, graph), ...codeScreens(graph)];
}
