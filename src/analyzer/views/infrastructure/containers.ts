import { posix } from 'node:path';
import {
  allStrings,
  basename,
  dirOf,
  isRecord,
  readConfig,
  readYaml,
  strings,
  text,
  withComponent,
} from '../shared.js';
import { categorizeImage, type Collected, type Source } from './model.js';

// Dockerfiles and Docker Compose. A compose service that builds from a Dockerfile is
// linked to that image, and services that name each other in their environment
// (`DATABASE_URL=postgres://db:5432`) are connected.

const DOCKERFILE = /(^|\/)(Dockerfile(\.[^/]+)?|[^/]+\.dockerfile)$/i;
const COMPOSE = /(^|\/)(docker-)?compose[^/]*\.ya?ml$/i;

const dockerId = (path: string) => `docker:${path}`;

export const dockerfiles: Source = async ({
  repoDir,
  paths,
  findComponent,
}) => {
  const collected: Collected = { resources: [], links: [] };
  for (const path of paths.filter((p) => DOCKERFILE.test(p))) {
    const content = await readConfig(repoDir, path);
    if (!content) continue;
    // The last FROM is the image that runs; earlier ones are build stages.
    const from = [...content.matchAll(/^\s*FROM\s+(?:--\S+\s+)*(\S+)/gim)].at(
      -1,
    )?.[1];
    const ports = [...content.matchAll(/^\s*EXPOSE\s+(.+)$/gim)].flatMap((m) =>
      m[1]!.trim().split(/\s+/),
    );
    const dir = dirOf(path);
    collected.resources.push({
      id: dockerId(path),
      name: `${dir ? basename(dir) : 'Root'} image`,
      type: 'Dockerfile',
      category: 'image',
      detail: [
        from && `FROM ${from}`,
        ports.length && `port ${ports.join(', ')}`,
      ]
        .filter(Boolean)
        .join(' · '),
      path,
      ...withComponent(findComponent('', `${dir}/${basename(path)}`, dir)),
    });
  }
  return collected;
};

export const compose: Source = async ({ repoDir, paths, findComponent }) => {
  const collected: Collected = { resources: [], links: [] };
  const dockerfilePaths = new Set(paths.filter((p) => DOCKERFILE.test(p)));
  for (const path of paths.filter((p) => COMPOSE.test(p))) {
    const doc = await readYaml(repoDir, path);
    const services =
      doc && isRecord(doc['services']) ? doc['services'] : undefined;
    if (!services) continue;
    const dir = dirOf(path);
    const id = (name: string) => `compose:${path}:${name}`;
    const names = Object.keys(services);

    for (const [name, service] of Object.entries(services)) {
      if (!isRecord(service)) continue;
      const image = text(service['image']);
      const build = service['build'];
      const context = isRecord(build) ? text(build['context']) : text(build);
      const contextDir = context
        ? posix.join(dir, context).replace(/^\.$/, '')
        : undefined;
      const ports = strings(service['ports']);
      collected.resources.push({
        id: id(name),
        name,
        type: 'Compose service',
        category: categorizeImage(image ?? name),
        detail: [
          image ?? (context && `build ${context}`),
          ports.length && `ports ${ports.join(', ')}`,
        ]
          .filter(Boolean)
          .join(' · '),
        path,
        ...withComponent(
          context
            ? findComponent(
                dir,
                context.startsWith('.') ? context : `./${context}`,
              )
            : undefined,
        ),
      });

      if (contextDir !== undefined) {
        const file =
          (isRecord(build) && text(build['dockerfile'])) || 'Dockerfile';
        const dockerfile = posix.join(contextDir, file).replace(/^\.\//, '');
        if (dockerfilePaths.has(dockerfile)) {
          collected.links.push({
            from: id(name),
            to: dockerId(dockerfile),
            label: 'builds',
          });
        }
      }

      const dependsOn = Array.isArray(service['depends_on'])
        ? strings(service['depends_on'])
        : isRecord(service['depends_on'])
          ? Object.keys(service['depends_on'])
          : [];
      for (const target of [...dependsOn, ...strings(service['links'])]) {
        const other = target.split(':')[0]!;
        if (names.includes(other) && other !== name) {
          collected.links.push({
            from: id(name),
            to: id(other),
            label: 'depends on',
          });
        }
      }
      // A service's environment naming another as a host: `redis://cache:6379`, `DB_HOST=db`.
      const env = new Set(
        allStrings(service['environment']).flatMap((s) =>
          s.split(/[^A-Za-z0-9_.-]+/),
        ),
      );
      for (const other of names) {
        if (other !== name && !dependsOn.includes(other) && env.has(other)) {
          collected.links.push({
            from: id(name),
            to: id(other),
            label: 'connects',
          });
        }
      }
    }
  }
  return collected;
};
