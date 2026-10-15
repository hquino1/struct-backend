import type { ComponentFinder } from '../shared.js';

// What each infrastructure source (Terraform, CloudFormation, compose, ...) reports before
// the extractor merges, filters, and connects them.

// `glue` is wiring such as IAM policies, listeners, and subscriptions: not drawn itself,
// but the extractor connects what it links (Lambda -> role -> policy -> table).
export type Category =
  | 'network'
  | 'compute'
  | 'image'
  | 'data'
  | 'messaging'
  | 'security'
  | 'other'
  | 'glue';

export interface Resource {
  id: string;
  name: string;
  // The source's own type name, e.g. "aws_lambda_function" or "AWS::SQS::Queue".
  type: string;
  category: Category;
  detail: string;
  path: string;
  componentId?: string;
}

export interface Link {
  from: string;
  to: string;
  label: string;
}

export interface Collected {
  resources: Resource[];
  links: Link[];
}

export interface SourceContext {
  repoDir: string;
  paths: string[];
  findComponent: ComponentFinder;
}

export type Source = (context: SourceContext) => Promise<Collected>;

// Cloud resource types, normalized to lower snake case ("AWS::DynamoDB::Table" becomes
// "aws_dynamodb_table"), sorted into categories. Checked in order: glue first, then data
// before compute, so "aws_db_instance" is data rather than a VM.
const CATEGORY_PATTERNS: [Category, RegExp][] = [
  [
    'glue',
    /policy|attachment|association|_rule|permission|_route|routetable|subnet|_vpc|^aws_ec2_vpc|security_?group|network_?acl|internet_?gateway|nat_?gateway|_eip$|log_?group|alarm|_version$|_alias$|_deployment$|_stage$|instance_?profile|_integration|_method$|_resource$|subscription|event_?source_?mapping|event_?target|listener|target_?group|_role$|_iam_|^aws_iam|lambda_function_url|_url$|_lambdapermission/,
  ],
  [
    'data',
    /dynamodb|db_?instance|db_?cluster|rds_|_rds|s3_bucket$|elasticache|redis|memcache|sql|cosmos|bigtable|firestore|spanner|storage_bucket|storage_account|opensearch|elasticsearch|efs|ecr_repository|docdb|neptune|redshift|simpletable/,
  ],
  [
    'messaging',
    /sqs_queue$|sns_topic$|kinesis|event_?bus|eventbridge|pubsub|servicebus|eventhub|msk_cluster|mq_broker/,
  ],
  [
    'security',
    /cognito|identity|secret|kms_key|certificate|acm_|waf|ssm_parameter/,
  ],
  [
    'network',
    /_lb$|_alb$|_elb$|load_?balancer|elasticloadbalancing|api_gateway_rest_api|apigateway_restapi|apigatewayv2_api|serverless_(http)?api|cloudfront|route53_zone|hostedzone|dns_zone|frontdoor|url_map|_cdn/,
  ],
  [
    'compute',
    /lambda_function|serverless_function|ecs_service|task_?definition|_instance$|autoscaling|eks_cluster|ecs_cluster|node_group|cloud_run|cloudfunctions|function_app|web_app|app_service|container_app|kubernetes_deployment|beanstalk|apprunner|batch_job|state_?machine|container_cluster/,
  ],
];

export const normalizeType = (type: string) =>
  type.replace(/::/g, '_').toLowerCase();

const matchCategory = (type: string) =>
  CATEGORY_PATTERNS.find(([, pattern]) => pattern.test(type))?.[0];

// The category of a cloud resource type. An unrecognised sub-resource of a known type
// (e.g. "aws_s3_bucket_versioning" under "aws_s3_bucket") is glue: it configures its parent.
export function categorize(rawType: string): Category {
  const type = normalizeType(rawType);
  const own = matchCategory(type);
  if (own) return own;
  const parts = type.split('_');
  for (let n = parts.length - 1; n >= 2; n--) {
    if (matchCategory(parts.slice(0, n).join('_'))) return 'glue';
  }
  return 'other';
}

// Container images that are well-known data stores, brokers, or proxies, for compose and
// Kubernetes services that run them.
const IMAGE_CATEGORIES: [Category, RegExp][] = [
  [
    'data',
    /postgres|mysql|mariadb|mongo|redis|valkey|memcached|elasticsearch|opensearch|minio|dynamodb|cassandra|couchdb|clickhouse|neo4j|influxdb|cockroach|mssql|sqlserver/,
  ],
  ['messaging', /rabbitmq|kafka|nats|redpanda|activemq|pulsar|zookeeper/],
  ['network', /nginx|traefik|caddy|haproxy|envoy|kong/],
];

export const categorizeImage = (image: string): Category =>
  IMAGE_CATEGORIES.find(([, pattern]) =>
    pattern.test(image.toLowerCase()),
  )?.[0] ?? 'compute';
