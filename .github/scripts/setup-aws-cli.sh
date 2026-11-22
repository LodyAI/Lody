#!/usr/bin/env bash
set -euo pipefail

if command -v aws >/dev/null 2>&1; then
  aws --version
  exit 0
fi

aws_download_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/lody-aws.XXXXXX")"
trap 'rm -rf "$aws_download_dir"' EXIT
case "$(uname -s)" in
  Darwin)
    curl --fail --silent --show-error --location --retry 3 https://awscli.amazonaws.com/AWSCLIV2.pkg -o "$aws_download_dir/aws.pkg"
    sudo installer -pkg "$aws_download_dir/aws.pkg" -target /
    ;;
  Linux)
    case "$(uname -m)" in
      x86_64) aws_arch=x86_64 ;;
      aarch64|arm64) aws_arch=aarch64 ;;
      *) echo 'Unsupported AWS CLI architecture' >&2; exit 1 ;;
    esac
    curl --fail --silent --show-error --location --retry 3 "https://awscli.amazonaws.com/awscli-exe-linux-${aws_arch}.zip" -o "$aws_download_dir/aws.zip"
    unzip -q "$aws_download_dir/aws.zip" -d "$aws_download_dir"
    aws_install_dir="${RUNNER_TEMP}/lody-aws-cli"
    "$aws_download_dir/aws/install" --install-dir "$aws_install_dir/cli" --bin-dir "$aws_install_dir/bin"
    echo "$aws_install_dir/bin" >> "$GITHUB_PATH"
    "$aws_install_dir/bin/aws" --version
    exit 0
    ;;
  *) echo 'Unsupported AWS CLI operating system' >&2; exit 1 ;;
esac
aws --version
