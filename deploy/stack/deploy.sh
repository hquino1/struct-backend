#!/usr/bin/env bash
# Deploys all of Struct into the AWS account your CLI is signed in to, or updates an earlier
# deployment with the current code. Safe to re-run.
#
#   bash deploy.sh                 stack "struct" in us-east-2
#   STACK_NAME=struct-demo AWS_REGION=us-west-2 FRONTEND_DIR=~/code/struct-frontend bash deploy.sh
#
# Needs: AWS CLI v2 (signed in as an administrator), Docker (running), bash.
# On Windows, run it from Git Bash or WSL.
set -euo pipefail

STACK_NAME="${STACK_NAME:-struct}"
REGION="${AWS_REGION:-us-east-2}"
here="$(cd "$(dirname "$0")" && pwd)"
backend="$(cd "$here/../.." && pwd)"
# The frontend repository, cloned next to this one as "frontend" or "struct-frontend".
if [ -z "${FRONTEND_DIR:-}" ]; then
  for dir in "$backend/../frontend" "$backend/../struct-frontend"; do
    [ -f "$dir/package.json" ] && FRONTEND_DIR="$dir" && break
  done
fi
[ -n "${FRONTEND_DIR:-}" ] && [ -d "$FRONTEND_DIR" ] ||
  { echo "Error: frontend not found next to $backend; set FRONTEND_DIR." >&2; exit 1; }
frontend="$(cd "$FRONTEND_DIR" && pwd)"

step() { printf '\n==> %s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
# The Windows AWS CLI ends lines with \r.
awsq() { aws --region "$REGION" "$@" | tr -d '\r'; }
output() {
  awsq cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
deploy_stack() {
  aws --region "$REGION" cloudformation deploy \
    --stack-name "$STACK_NAME" \
    --template-file "$here/struct-stack.yaml" \
    --capabilities CAPABILITY_IAM \
    --no-fail-on-empty-changeset "$@"
}

[[ "$STACK_NAME" =~ ^[a-z][a-z0-9-]{0,19}$ ]] ||
  fail "STACK_NAME must be lowercase letters, digits and dashes, at most 20 characters."
command -v aws >/dev/null || fail "the AWS CLI is not installed."
command -v docker >/dev/null || fail "Docker is not installed."
docker info >/dev/null 2>&1 || fail "Docker is not running."
[ -f "$backend/Dockerfile" ] || fail "no Dockerfile in $backend."
[ -f "$frontend/package.json" ] || fail "no frontend in $frontend (set FRONTEND_DIR)."

account="$(awsq sts get-caller-identity --query Account --output text)" ||
  fail "the AWS CLI is not signed in (run 'aws configure' or 'aws sso login')."
step "Deploying stack '$STACK_NAME' to account $account in $REGION"

# 1. Everything except the running API. The first run takes 15-25 minutes, mostly CloudFront.
step "Creating or updating the infrastructure (first run: 15-25 minutes)"
deploy_stack

# Let CloudFront's VPC origin reach the internal ALB. CloudFront creates its security group
# with the VPC origin, so the stack can't reference it (see AlbSecurityGroup in the template).
step "Allowing CloudFront to reach the load balancer"
vpc="$(output VpcId)"
alb_sg="$(output AlbSecurityGroupId)"
cf_sg="$(awsq ec2 describe-security-groups \
  --filters "Name=vpc-id,Values=$vpc" "Name=group-name,Values=CloudFront-VPCOrigins-Service-SG" \
  --query "SecurityGroups[0].GroupId" --output text)"
[ -n "$cf_sg" ] && [ "$cf_sg" != "None" ] ||
  fail "CloudFront's VPC origin security group was not found in $vpc."
existing="$(awsq ec2 describe-security-groups --group-ids "$alb_sg" \
  --query "SecurityGroups[0].IpPermissions[?FromPort==\`80\`].UserIdGroupPairs[].GroupId" --output text)"
if [[ "$existing" != *"$cf_sg"* ]]; then
  awsq ec2 authorize-security-group-ingress --group-id "$alb_sg" \
    --protocol tcp --port 80 --source-group "$cf_sg" >/dev/null
fi

repo="$(output RepositoryUri)"
registry="${repo%%/*}"

# 2. Backend image: one image runs both the API and the analyzer.
tag="$(date -u +%Y%m%d%H%M%S)"
if sha="$(git -C "$backend" rev-parse --short HEAD 2>/dev/null)"; then tag="$tag-$sha"; fi
step "Building and pushing the backend image ($tag)"
awsq ecr get-login-password | docker login --username AWS --password-stdin "$registry"
docker build --platform linux/amd64 -t "$repo:$tag" "$backend"
docker push "$repo:$tag"

# 3. Point both task definitions at the image and start the API.
step "Starting the API on the new image"
deploy_stack --parameter-overrides "ImageTag=$tag"

# 4. Frontend, built with this stack's Cognito IDs.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
step "Building the frontend"
(
  cd "$work"
  docker build \
    -f "$here/frontend-build.Dockerfile" \
    --build-arg "VITE_COGNITO_USER_POOL_ID=$(output UserPoolId)" \
    --build-arg "VITE_COGNITO_CLIENT_ID=$(output UserPoolClientId)" \
    --output type=local,dest=site \
    "$frontend"
)
[ -f "$work/site/_shell.html" ] || fail "the frontend build produced no _shell.html."

step "Uploading the frontend"
bucket="$(output BucketName)"
(
  cd "$work"
  # Hashed assets are cached for a year and never deleted, so open tabs keep working.
  aws --region "$REGION" s3 sync site/assets "s3://$bucket/assets" \
    --cache-control "public,max-age=31536000,immutable" --only-show-errors
  aws --region "$REGION" s3 sync site "s3://$bucket" --exclude "assets/*" \
    --cache-control "no-cache" --delete --only-show-errors
)
awsq cloudfront create-invalidation --distribution-id "$(output DistributionId)" \
  --paths "/*" --query Invalidation.Id --output text >/dev/null

url="$(output SiteUrl)"
step "Done"
cat <<EOF
Struct is at  $url
(After a first deploy, CloudFront can take a few more minutes before it answers.)

Check it:     curl -i $url/api/projects   (401 means the API is up; 503 or 504 means it isn't)
Sign up on the site with an email address; Cognito emails a verification code.
Remove it:    STACK_NAME=$STACK_NAME AWS_REGION=$REGION bash destroy.sh
EOF
