# Deploy Struct to your own AWS account

One script creates everything Struct needs in your account, builds both apps and puts them
online at an HTTPS address. A second script removes all of it again.

## What you need

- An AWS account, and the [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
  signed in as a user or role with administrator access (`aws sts get-caller-identity` should
  print your account).
- [Docker](https://www.docker.com/products/docker-desktop/), running. Node is not needed; the
  builds run inside Docker.
- bash. On Windows, use **Git Bash** (comes with [Git for Windows](https://git-scm.com/download/win)) or WSL.
- Both repositories, cloned into the same parent folder:

  ```bash
  git clone https://github.com/hquino1/struct-backend.git
  git clone https://github.com/hquino1/struct-frontend.git
  ```

### Signing the AWS CLI in

If the CLI isn't signed in to your account yet, create an access key for an administrator:

1. In the AWS console, open **IAM → Users**, and pick (or create) a user with the
   `AdministratorAccess` policy.
2. On its **Security credentials** tab, choose **Create access key**, use case
   **Command Line Interface (CLI)**, accept the warning, and download the `.csv` (the secret is
   shown only once).
3. In a terminal:

   ```bash
   aws configure                 # paste the two keys; region: us-east-2; output: press Enter
   aws sts get-caller-identity   # should print your account number
   ```

An administrator key controls the whole account: never commit or share it, and deactivate it
under **Security credentials** when you're done.

## Deploy

```bash
cd struct-backend/deploy/stack
bash deploy.sh
```

The first run takes **20–30 minutes**, mostly waiting for CloudFront. It ends by printing the
site's address, for example `https://d1234abcd.cloudfront.net`. Open it, choose **Sign up**, and
enter an email address; Cognito sends a verification code to it.

To deploy code changes later, pull and run `bash deploy.sh` again (about 5 minutes).

Options, as environment variables:

| Variable | Default | |
|---|---|---|
| `AWS_REGION` | `us-east-2` | Keep a US region: the fallback model is a US-only inference profile. |
| `STACK_NAME` | `struct` | Lowercase, at most 20 characters. Use different names for side-by-side copies. |
| `FRONTEND_DIR` | `../struct-frontend` | Only if the frontend is cloned somewhere else. |

## Remove it

```bash
bash destroy.sh
```

This deletes every resource, every user account and all data. It takes 10–20 minutes.

## Cost

About **$30 a month** while deployed: the load balancer (~$16), the always-on API task (~$9) and
its public IP (~$4). Analyses run as separate tasks billed per second, plus Bedrock tokens (cents
per analysis). DynamoDB, S3, Cognito and CloudFront stay in the free tier or cost pennies at class
scale. Run `destroy.sh` when you're done.

## What it creates

All of it is in one CloudFormation stack ([struct-stack.yaml](struct-stack.yaml)):

```
browser ──HTTPS──> CloudFront ──/*──────> S3 bucket (private)
                              └─/api/*──> VPC origin ──> internal ALB ──> API (ECS Fargate)
                                                                          │ starts per analysis
                                                                          ▼
                                                     analyzer task ──> GitHub, Bedrock
API and analyzer ──> DynamoDB table          Sign-in: Cognito user pool
```

A new VPC with two public subnets, an ECR repository for the backend image, CloudWatch log
groups (`/ecs/<stack>-api`, `/ecs/<stack>-analyzer`) and IAM roles scoped to these resources.
Nothing outside the stack is changed.

## Limits of this setup

- **Public repositories only.** Private ones need a GitHub App, which this setup leaves out
  (see `GITHUB_APP_*` in `backend/.env.example`).
- **Emails:** Cognito's built-in sender allows only a few dozen verification emails per day.

## If something goes wrong

- **The site loads but sign-in or the project list fails:** run `curl -i <site>/api/projects`.
  `401` is correct (you're not signed in). `503` means the API isn't running; check the
  `/ecs/<stack>-api` log group in CloudWatch. `504` means CloudFront can't reach the load
  balancer; run `deploy.sh` again, which re-adds the rule that lets it in.
- **An analysis fails right away:** look in the `/ecs/<stack>-analyzer` log group. An
  `AccessDeniedException` about the model means Bedrock has not enabled it for your account yet:
  in the Bedrock console (same region), open the model catalog, find
  *Qwen3 Coder 480B* and *Nova 2 Lite*, and request access or try each once in the playground.
- **`deploy.sh` stops during "Creating or updating the infrastructure":** the error names the
  failed resource. Fix the cause, then run `deploy.sh` again. If the very first run failed, run
  `destroy.sh` first.
