#!/usr/bin/env bash
# Deletes everything deploy.sh created, including all user accounts and data.
#
#   bash destroy.sh
#   STACK_NAME=struct-demo AWS_REGION=us-west-2 bash destroy.sh
set -euo pipefail

STACK_NAME="${STACK_NAME:-struct}"
REGION="${AWS_REGION:-us-east-2}"

awsq() { aws --region "$REGION" "$@" | tr -d '\r'; }
output() {
  awsq cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

awsq cloudformation describe-stacks --stack-name "$STACK_NAME" >/dev/null ||
  { echo "No stack '$STACK_NAME' in $REGION."; exit 1; }

read -r -p "Delete stack '$STACK_NAME' in $REGION with all its users and data? Type its name: " answer
[ "$answer" = "$STACK_NAME" ] || { echo "Cancelled."; exit 1; }

# CloudFormation can't delete a bucket that still holds files.
bucket="$(output BucketName)"
vpc="$(output VpcId)"
if [ -n "$bucket" ] && [ "$bucket" != "None" ]; then
  echo "Emptying s3://$bucket"
  aws --region "$REGION" s3 rm "s3://$bucket" --recursive --only-show-errors
fi

delete() {
  echo "Deleting the stack (10-20 minutes; CloudFront has to disable first)"
  aws --region "$REGION" cloudformation delete-stack --stack-name "$STACK_NAME"
  aws --region "$REGION" cloudformation wait stack-delete-complete --stack-name "$STACK_NAME"
}

if ! delete; then
  # CloudFront creates this security group for the VPC origin outside the stack, and it can
  # keep the VPC from being deleted.
  sg="$(awsq ec2 describe-security-groups \
    --filters "Name=vpc-id,Values=$vpc" "Name=group-name,Values=CloudFront-VPCOrigins-Service-SG" \
    --query "SecurityGroups[0].GroupId" --output text)"
  if [ -n "$sg" ] && [ "$sg" != "None" ]; then
    echo "Removing CloudFront's leftover security group $sg and retrying"
    aws --region "$REGION" ec2 delete-security-group --group-id "$sg"
  fi
  delete
fi
echo "Deleted."
