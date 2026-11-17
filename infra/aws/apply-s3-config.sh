#!/usr/bin/env bash
set -euo pipefail

bucket=""
region=""
dry_run="false"
create_bucket="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket)
      bucket="${2:-}"
      shift 2
      ;;
    --region)
      region="${2:-}"
      shift 2
      ;;
    --create-bucket)
      create_bucket="true"
      shift
      ;;
    --dry-run)
      dry_run="true"
      shift
      ;;
    --help|-h)
      echo "Usage: infra/aws/apply-s3-config.sh --bucket YOUR_JAYTRACE_BUCKET [--region AWS_REGION] [--create-bucket] [--dry-run]"
      echo ""
      echo "  --bucket         target bucket name (required)"
      echo "  --region         AWS region, required with --create-bucket outside us-east-1"
      echo "  --create-bucket  create the bucket, block public access, and enable SSE-S3"
      echo "                   before applying lifecycle/CORS config"
      echo "  --dry-run        print the AWS CLI commands instead of running them"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$bucket" ]]; then
  echo "--bucket is required" >&2
  exit 1
fi

if [[ "$create_bucket" == "true" && -z "$region" ]]; then
  echo "--region is required with --create-bucket" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

run() {
  if [[ "$dry_run" == "true" ]]; then
    printf "%q " "$@"
    printf "\n"
  else
    "$@"
  fi
}

if [[ "$create_bucket" == "true" ]]; then
  if [[ "$region" == "us-east-1" ]]; then
    run aws s3api create-bucket \
      --bucket "$bucket" \
      --region "$region"
  else
    run aws s3api create-bucket \
      --bucket "$bucket" \
      --region "$region" \
      --create-bucket-configuration "LocationConstraint=$region"
  fi

  run aws s3api put-public-access-block \
    --bucket "$bucket" \
    --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

  run aws s3api put-bucket-encryption \
    --bucket "$bucket" \
    --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
fi

run aws s3api put-bucket-lifecycle-configuration \
  --bucket "$bucket" \
  --lifecycle-configuration "file://$script_dir/s3-lifecycle.json"

run aws s3api put-bucket-cors \
  --bucket "$bucket" \
  --cors-configuration "file://$script_dir/s3-cors.json"
