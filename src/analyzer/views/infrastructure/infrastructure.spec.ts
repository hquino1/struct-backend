import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Component } from '../../architecture.js';
import { listRepositoryFiles } from '../../repository.js';
import type { ViewGraph } from '../view-graph.js';
import { infrastructureExtractor } from './index.js';
import { categorize } from './model.js';

const component = (id: string, paths: string[]): Component => ({
  id,
  name: id,
  type: 'service',
  tech: '',
  description: '',
  paths,
  entryPoint: '',
});

const TERRAFORM = `
resource "aws_lambda_function" "api" {
  function_name = "api"
  filename      = "\${path.module}/../backend/dist.zip"
  role          = aws_iam_role.api.arn
  environment {
    variables = { TABLE = aws_dynamodb_table.orders.name }
  }
}

resource "aws_iam_role" "api" {
  name = "api"
}

resource "aws_iam_role_policy" "api" {
  role   = aws_iam_role.api.id
  policy = jsonencode({
    Statement = [{ Action = ["s3:GetObject"], Resource = "\${aws_s3_bucket.assets.arn}/*" }]
  })
}

resource "aws_dynamodb_table" "orders" {
  name = "orders"
}

resource "aws_s3_bucket" "assets" {
  bucket = "assets"
}

resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
}

resource "aws_api_gateway_rest_api" "public" {
  name = "public"
}

resource "aws_api_gateway_method" "proxy" {
  rest_api_id = aws_api_gateway_rest_api.public.id
}

resource "aws_api_gateway_integration" "proxy" {
  rest_api_id = aws_api_gateway_rest_api.public.id
  uri         = aws_lambda_function.api.invoke_arn
}
`;

const SAM = `
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Resources:
  Worker:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: ../worker/
      Environment:
        Variables:
          TABLE: !Ref Jobs
      Events:
        Http:
          Type: Api
          Properties:
            Path: /jobs
            Method: post
        Queue:
          Type: SQS
          Properties:
            Queue: !GetAtt JobQueue.Arn
  Jobs:
    Type: AWS::DynamoDB::Table
  JobQueue:
    Type: AWS::SQS::Queue
  WorkerRole:
    Type: AWS::IAM::Role
`;

const COMPOSE = `
services:
  api:
    build: ./backend
    ports: ["3000:3000"]
    depends_on: [db]
    environment:
      CACHE_URL: redis://cache:6379
  db:
    image: postgres:16
  cache:
    image: redis:7
  proxy:
    image: nginx:1.27
    depends_on:
      api:
        condition: service_started
`;

const DOCKERFILE = `
FROM node:22 AS build
RUN npm ci
FROM node:22-alpine
EXPOSE 3000
`;

const K8S = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders
  namespace: shop
spec:
  template:
    metadata:
      labels: { app: orders }
    spec:
      containers:
        - name: orders
          image: ghcr.io/acme/orders:1.0
          env:
            - name: PAYMENTS_URL
              value: http://payments.shop.svc:8080
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: orders-data }
---
apiVersion: v1
kind: Service
metadata: { name: orders, namespace: shop }
spec:
  selector: { app: orders }
---
apiVersion: v1
kind: Service
metadata: { name: payments, namespace: shop }
spec:
  selector: { app: payments }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: public, namespace: shop }
spec:
  rules:
    - http:
        paths:
          - path: /
            backend:
              service: { name: orders, port: { number: 80 } }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: orders-data, namespace: shop }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: settings, namespace: shop }
`;

const WRANGLER = `{
  // The storefront worker
  "name": "storefront",
  "main": "src/server.ts",
  "kv_namespaces": [{ "binding": "SESSIONS", "id": "abc" }],
  "queues": { "consumers": [{ "queue": "emails" }] },
}`;

// These views never call the model.
const noModel = {
  callTool: () => Promise.reject(new Error('unexpected model call')),
};

describe('categorize', () => {
  it('sorts cloud resource types, treating wiring and sub-resources as glue', () => {
    expect(categorize('aws_lambda_function')).toBe('compute');
    expect(categorize('AWS::Serverless::Function')).toBe('compute');
    expect(categorize('aws_db_instance')).toBe('data');
    expect(categorize('AWS::DynamoDB::Table')).toBe('data');
    expect(categorize('aws_sqs_queue')).toBe('messaging');
    expect(categorize('aws_lb')).toBe('network');
    expect(categorize('AWS::ApiGateway::RestApi')).toBe('network');
    expect(categorize('aws_cognito_user_pool')).toBe('security');
    expect(categorize('aws_iam_role')).toBe('glue');
    expect(categorize('AWS::Lambda::Permission')).toBe('glue');
    expect(categorize('aws_s3_bucket_versioning')).toBe('glue');
    expect(categorize('aws_sqs_queue_policy')).toBe('glue');
    expect(categorize('aws_cloudwatch_dashboard')).toBe('other');
  });
});

describe('infrastructureExtractor', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'struct-infra-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const file = async (path: string, content: string) => {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  };

  const extract = async (components: Component[] = []) => {
    const paths = await listRepositoryFiles(dir);
    return infrastructureExtractor.extract({
      repoDir: dir,
      paths,
      components,
      facts: new Map(),
      llm: noModel,
    });
  };

  const helpers = ({ nodes, edges }: ViewGraph) => ({
    node: (id: string) => nodes.find((n) => n.id === id),
    edge: (from: string, to: string) =>
      edges.find((e) => e.from === from && e.to === to),
  });

  it('applies only when the repository has infrastructure files', () => {
    expect(infrastructureExtractor.applies(['src/main.ts', 'README.md'])).toBe(
      false,
    );
    expect(infrastructureExtractor.applies(['infra/main.tf'])).toBe(true);
    expect(infrastructureExtractor.applies(['backend/Dockerfile'])).toBe(true);
    expect(infrastructureExtractor.applies(['.github/workflows/ci.yml'])).toBe(
      false,
    );
  });

  it('maps Terraform resources and connects them through IAM and API Gateway glue', async () => {
    await file('infra/main.tf', TERRAFORM);
    const graph = await extract([component('api', ['backend'])]);
    const { node, edge } = helpers(graph);
    const id = (key: string) => `tf:infra:${key}`;

    expect(node(id('aws_lambda_function.api'))).toMatchObject({
      name: 'api',
      kind: 'compute',
      group: 'Compute',
      componentId: 'api',
      path: 'infra/main.tf',
    });
    expect(node(id('aws_dynamodb_table.orders'))).toMatchObject({
      kind: 'data',
      group: 'Data & messaging',
    });
    expect(node(id('aws_api_gateway_rest_api.public'))).toMatchObject({
      group: 'Network',
    });
    // Glue isn't drawn.
    expect(node(id('aws_iam_role.api'))).toBeUndefined();
    expect(node(id('aws_s3_bucket_versioning.assets'))).toBeUndefined();

    expect(
      edge(id('aws_lambda_function.api'), id('aws_dynamodb_table.orders')),
    ).toMatchObject({ label: 'uses' });
    // Lambda -> role <- policy -> bucket.
    expect(
      edge(id('aws_lambda_function.api'), id('aws_s3_bucket.assets')),
    ).toMatchObject({ label: 'access' });
    // API <- method/integration -> Lambda, drawn from the API.
    expect(
      edge(
        id('aws_api_gateway_rest_api.public'),
        id('aws_lambda_function.api'),
      ),
    ).toMatchObject({ label: 'routes to' });
  });

  it('maps a SAM template with implicit APIs and event triggers', async () => {
    await file('infra/template.yaml', SAM);
    const graph = await extract([component('worker', ['worker'])]);
    const { node, edge } = helpers(graph);
    const id = (logicalId: string) => `cfn:infra/template.yaml:${logicalId}`;

    expect(node(id('Worker'))).toMatchObject({
      kind: 'compute',
      componentId: 'worker',
    });
    expect(edge(id('Worker'), id('Jobs'))).toMatchObject({ label: 'uses' });
    expect(edge(id('JobQueue'), id('Worker'))).toMatchObject({
      label: 'triggers',
    });
    expect(edge(id('ImplicitApi'), id('Worker'))).toMatchObject({
      label: 'routes to',
    });
    expect(node(id('ImplicitApi'))).toMatchObject({ group: 'Network' });
    expect(node(id('WorkerRole'))).toBeUndefined();
  });

  it('maps compose services, their images, and the services they reach', async () => {
    await file('docker-compose.yml', COMPOSE);
    await file('backend/Dockerfile', DOCKERFILE);
    const graph = await extract([component('api', ['backend'])]);
    const { node, edge } = helpers(graph);
    const id = (name: string) => `compose:docker-compose.yml:${name}`;

    expect(node(id('api'))).toMatchObject({
      kind: 'compute',
      componentId: 'api',
      detail: 'build ./backend · ports 3000:3000',
    });
    expect(node(id('db'))).toMatchObject({ kind: 'data' });
    expect(node(id('cache'))).toMatchObject({ kind: 'data' });
    expect(node(id('proxy'))).toMatchObject({ kind: 'network' });
    expect(node('docker:backend/Dockerfile')).toMatchObject({
      kind: 'image',
      name: 'backend image',
      detail: 'FROM node:22-alpine · port 3000',
      componentId: 'api',
    });
    expect(edge(id('api'), 'docker:backend/Dockerfile')).toMatchObject({
      label: 'builds',
    });
    expect(edge(id('api'), id('db'))).toMatchObject({ label: 'depends on' });
    expect(edge(id('api'), id('cache'))).toMatchObject({ label: 'connects' });
    expect(edge(id('proxy'), id('api'))).toMatchObject({ label: 'depends on' });
  });

  it('maps Kubernetes workloads, services, ingresses, and volume claims', async () => {
    await file('deploy/k8s/orders.yaml', K8S);
    const graph = await extract();
    const { node, edge } = helpers(graph);
    const id = (kind: string, name: string) => `k8s:shop/${kind}/${name}`;

    expect(node(id('Deployment', 'orders'))).toMatchObject({
      kind: 'compute',
      detail: 'Deployment · ghcr.io/acme/orders:1.0 · ns shop',
    });
    expect(
      edge(id('Service', 'orders'), id('Deployment', 'orders')),
    ).toMatchObject({ label: 'routes to' });
    expect(
      edge(id('Ingress', 'public'), id('Service', 'orders')),
    ).toMatchObject({ label: 'routes to' });
    expect(
      edge(
        id('Deployment', 'orders'),
        id('PersistentVolumeClaim', 'orders-data'),
      ),
    ).toMatchObject({ label: 'mounts' });
    expect(
      edge(id('Deployment', 'orders'), id('Service', 'payments')),
    ).toMatchObject({ label: 'connects' });
    expect(node(id('ConfigMap', 'settings'))).toBeUndefined();
  });

  it('maps a Cloudflare Worker and its bindings from wrangler.jsonc', async () => {
    await file('web/wrangler.jsonc', WRANGLER);
    const graph = await extract([component('web', ['web'])]);
    const { node, edge } = helpers(graph);
    const worker = 'cf:web/wrangler.jsonc';

    expect(node(worker)).toMatchObject({
      name: 'storefront',
      kind: 'compute',
      componentId: 'web',
    });
    expect(edge(worker, `${worker}:KV namespace:SESSIONS`)).toMatchObject({
      label: 'binding',
    });
    expect(edge(`${worker}:Queue:emails`, worker)).toMatchObject({
      label: 'triggers',
    });
  });

  it('returns nothing for a repository without infrastructure', async () => {
    await file('config/settings.yml', 'debug: true\n');
    const { nodes } = await extract();
    expect(nodes).toEqual([]);
  });
});
