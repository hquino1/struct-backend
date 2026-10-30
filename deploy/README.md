# Deploying the backend to ECS Fargate (us-east-2)

The files in this folder are the source of truth for the ECS setup. Use them once by hand (the
steps below), then the GitHub Actions pipeline reuses the two task definition files.

| File | Purpose |
|---|---|
| `ecs-tasks-trust-policy.json` | Lets ECS tasks assume the three roles below |
| `api-task-role-policy.json` | API: DynamoDB, start the analyzer task, pass its roles |
| `analyzer-task-role-policy.json` | Analyzer: DynamoDB, Bedrock |
| `api-task-def.json` | `struct-api` task (port 3000) |
| `analyzer-task-def.json` | `struct-analyzer` task (`node dist/worker.js`) |

Run everything from `backend/deploy/` in PowerShell, as an IAM user with `deployer-policy.json`
attached. Every command passes `--region us-east-2` because the CLI's default region is us-east-1.

Already created (2026-10-28): ALB `struct-alb-531782505.us-east-2.elb.amazonaws.com`, security
groups ALB `sg-0ca35ad699e1d3b72`, API `sg-0b1570fac13478b7a`, analyzer `sg-0b7e1031ed9038bd5`.

## 1. IAM roles

```powershell
# Execution role: pulls the image from ECR and writes logs
aws iam create-role --role-name struct-ecs-execution-role --assume-role-policy-document file://ecs-tasks-trust-policy.json
aws iam attach-role-policy --role-name struct-ecs-execution-role --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

# Task roles: what the app code itself can do
aws iam create-role --role-name struct-api-task-role --assume-role-policy-document file://ecs-tasks-trust-policy.json
aws iam put-role-policy --role-name struct-api-task-role --policy-name struct-api --policy-document file://api-task-role-policy.json

aws iam create-role --role-name struct-analyzer-task-role --assume-role-policy-document file://ecs-tasks-trust-policy.json
aws iam put-role-policy --role-name struct-analyzer-task-role --policy-name struct-analyzer --policy-document file://analyzer-task-role-policy.json
```

## 2. Log groups

```powershell
aws logs create-log-group --log-group-name /ecs/struct-api --region us-east-2
aws logs create-log-group --log-group-name /ecs/struct-analyzer --region us-east-2
aws logs put-retention-policy --log-group-name /ecs/struct-api --retention-in-days 14 --region us-east-2
aws logs put-retention-policy --log-group-name /ecs/struct-analyzer --retention-in-days 14 --region us-east-2
```

## 3. Security groups (default VPC)

```powershell
$vpc = "vpc-0cfac54ac54b206c0"

# ALB: HTTP from anywhere
$albSg = aws ec2 create-security-group --group-name struct-alb --description "Struct ALB" --vpc-id $vpc --region us-east-2 --query GroupId --output text
aws ec2 authorize-security-group-ingress --group-id $albSg --protocol tcp --port 80 --cidr 0.0.0.0/0 --region us-east-2

# API: port 3000 from the ALB only
$apiSg = aws ec2 create-security-group --group-name struct-api --description "Struct API tasks" --vpc-id $vpc --region us-east-2 --query GroupId --output text
aws ec2 authorize-security-group-ingress --group-id $apiSg --protocol tcp --port 3000 --source-group $albSg --region us-east-2

# Analyzer: no inbound rules (outbound to GitHub and Bedrock is allowed by default)
$analyzerSg = aws ec2 create-security-group --group-name struct-analyzer --description "Struct analyzer tasks" --vpc-id $vpc --region us-east-2 --query GroupId --output text

"ALB: $albSg  API: $apiSg  Analyzer: $analyzerSg"
```

## 4. Fill in the two placeholders in `api-task-def.json`

- `REPLACE_WITH_ANALYZER_SG_ID` → the `$analyzerSg` value printed above
- `REPLACE_WITH_FRONTEND_URL` → the deployed frontend URL, e.g.
  `https://hquino1-struct-frontend.<your-subdomain>.workers.dev` (comma-separate several)

## 5. Cluster and task definitions

```powershell
aws ecs create-cluster --cluster-name struct-cluster --region us-east-2
aws ecs register-task-definition --cli-input-json file://analyzer-task-def.json --region us-east-2
aws ecs register-task-definition --cli-input-json file://api-task-def.json --region us-east-2
```

## 6. Load balancer

```powershell
$subnets = "subnet-0f13d0bc13ba303be", "subnet-0bfdf3d44bd5e5cf3", "subnet-0771ab1e55bc52f91"

$albArn = aws elbv2 create-load-balancer --name struct-alb --subnets $subnets --security-groups $albSg --region us-east-2 --query "LoadBalancers[0].LoadBalancerArn" --output text

$tgArn = aws elbv2 create-target-group --name struct-api --protocol HTTP --port 3000 --vpc-id $vpc --target-type ip --health-check-path / --region us-east-2 --query "TargetGroups[0].TargetGroupArn" --output text

aws elbv2 create-listener --load-balancer-arn $albArn --protocol HTTP --port 80 --default-actions "Type=forward,TargetGroupArn=$tgArn" --region us-east-2
```

## 7. API service

```powershell
aws ecs create-service --cluster struct-cluster --service-name struct-api --task-definition struct-api --desired-count 1 --launch-type FARGATE `
  --network-configuration "awsvpcConfiguration={subnets=[$($subnets -join ',')],securityGroups=[$apiSg],assignPublicIp=ENABLED}" `
  --load-balancers "targetGroupArn=$tgArn,containerName=api,containerPort=3000" `
  --region us-east-2
```

## 8. Check it

```powershell
aws ecs wait services-stable --cluster struct-cluster --services struct-api --region us-east-2
$dns = aws elbv2 describe-load-balancers --names struct-alb --region us-east-2 --query "LoadBalancers[0].DNSName" --output text
curl.exe "http://$dns/"
```

Then point the frontend at `http://$dns` and start an analysis. If it fails, check the
`/ecs/struct-api` and `/ecs/struct-analyzer` log groups.

## Notes

- **Bedrock access:** enable both models (`qwen.qwen3-coder-480b-a35b-v1:0`,
  `us.amazon.nova-2-lite-v1:0`) under Bedrock → Model access in us-east-2. The analyzer policy
  allows foundation models in any region because the `us.` inference profile routes across
  US regions.
- **Claude models:** a bare `anthropic.claude-*` model ID goes through a different Bedrock endpoint
  (see `src/analyzer/llm.service.ts`) and may need extra permissions in the analyzer policy.
- **HTTPS (2026-10-30):** the API is now served at `/api` (global prefix) through the frontend's
  CloudFront distribution, which reaches a new **internal** ALB (`struct-alb-internal`, target group
  `struct-api-internal`, health check `/api`) via a VPC origin. See `frontend/deploy/README.md`. The
  public `struct-alb` from step 6 is no longer used by the service.
- **Cost:** the ALB (~$16/month) and the API task run continuously; analyzer tasks are billed only
  while they run.
