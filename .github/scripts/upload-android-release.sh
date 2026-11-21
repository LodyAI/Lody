#!/usr/bin/env bash

set -euo pipefail

required_envs=(
  "R2_ACCOUNT_ID"
  "R2_BUCKET"
  "R2_MOBILE_ANDROID_PREFIX"
  "MOBILE_ANDROID_DOWNLOAD_BASE_URL"
  "MOBILE_VERSION_NAME"
  "MOBILE_VERSION_CODE"
)
for key in "${required_envs[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    echo "Missing required Android upload env: ${key}"
    exit 1
  fi
done

apk_path="mobile-android-release/app.apk"
if [[ ! -s "${apk_path}" ]]; then
  echo "Android APK is missing or empty: ${apk_path}"
  exit 1
fi

endpoint_url="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
prefix="${R2_MOBILE_ANDROID_PREFIX#/}"
prefix="${prefix%/}"
public_base_url="${MOBILE_ANDROID_DOWNLOAD_BASE_URL%/}"
immutable_name="lody-android-v${MOBILE_VERSION_NAME}+${MOBILE_VERSION_CODE}.apk"
alias_name="lody-android-latest.apk"
immutable_key="${prefix}/${immutable_name}"
alias_key="${prefix}/${alias_name}"
metadata_key="${prefix}/version.json"

file_sha256() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${path}" | awk '{print $1}'
  else
    shasum -a 256 "${path}" | awk '{print $1}'
  fi
}

r2_object_exists() {
  local key="$1"
  local error_path="${RUNNER_TEMP}/r2-head-error-$RANDOM.txt"
  if aws s3api head-object \
    --bucket "${R2_BUCKET}" \
    --key "${key}" \
    --endpoint-url "${endpoint_url}" \
    >/dev/null 2>"${error_path}"; then
    rm -f "${error_path}"
    return 0
  fi

  if grep -Eq '(^|[^0-9])404([^0-9]|$)|Not Found|NoSuchKey' "${error_path}"; then
    rm -f "${error_path}"
    return 1
  fi

  cat "${error_path}" >&2
  rm -f "${error_path}"
  return 2
}

# A versioned APK is immutable. A recovery may reuse the same bytes, but it must
# never replace an existing object with a different rebuild under the same URL.
existing_immutable="${RUNNER_TEMP}/existing-${immutable_name}"
if r2_object_exists "${immutable_key}"; then
  aws s3 cp "s3://${R2_BUCKET}/${immutable_key}" "${existing_immutable}" \
    --endpoint-url "${endpoint_url}" \
    --no-progress
  existing_sha="$(file_sha256 "${existing_immutable}")"
  candidate_sha="$(file_sha256 "${apk_path}")"
  if [[ "${existing_sha}" != "${candidate_sha}" ]]; then
    echo "Refusing to replace immutable ${immutable_key}: existing SHA-256 ${existing_sha}, candidate ${candidate_sha}"
    exit 1
  fi
  echo "Immutable ${immutable_key} already contains the same APK; keeping it."
else
  object_status="$?"
  if [[ "${object_status}" -ne 1 ]]; then
    exit "${object_status}"
  fi
  aws s3 cp "${apk_path}" "s3://${R2_BUCKET}/${immutable_key}" \
    --endpoint-url "${endpoint_url}" \
    --no-progress \
    --content-type application/vnd.android.package-archive \
    --cache-control "public, max-age=31536000, immutable"
fi

export MOBILE_ANDROID_ALIAS_NAME="${alias_name}"
export MOBILE_ANDROID_IMMUTABLE_NAME="${immutable_name}"
export MOBILE_ANDROID_DOWNLOAD_URL="${public_base_url}/${alias_name}"
export MOBILE_ANDROID_VERSION_DOWNLOAD_URL="${public_base_url}/${immutable_name}"
export MOBILE_ANDROID_RELEASE_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

node <<'NODE'
const fs = require('node:fs');

const metadata = {
  platform: 'android',
  version: process.env.MOBILE_VERSION_NAME,
  buildNumber: process.env.MOBILE_VERSION_CODE,
  releaseDate: process.env.MOBILE_ANDROID_RELEASE_DATE,
  downloadUrl: process.env.MOBILE_ANDROID_DOWNLOAD_URL,
  versionDownloadUrl: process.env.MOBILE_ANDROID_VERSION_DOWNLOAD_URL,
  files: [process.env.MOBILE_ANDROID_ALIAS_NAME, process.env.MOBILE_ANDROID_IMMUTABLE_NAME],
};

fs.writeFileSync('mobile-android-release/version.json', `${JSON.stringify(metadata, null, 2)}\n`);
NODE

# Keep a recoverable copy of the mutable alias. If metadata publication fails,
# restore the previous alias so the two mutable pointers do not advertise
# different releases.
alias_backup="${RUNNER_TEMP}/previous-${alias_name}"
alias_existed=false
if r2_object_exists "${alias_key}"; then
  aws s3 cp "s3://${R2_BUCKET}/${alias_key}" "${alias_backup}" \
    --endpoint-url "${endpoint_url}" \
    --no-progress
  alias_existed=true
else
  object_status="$?"
  if [[ "${object_status}" -ne 1 ]]; then
    exit "${object_status}"
  fi
fi

alias_mutated=false
rollback_alias() {
  local status="$?"
  if [[ "${status}" -eq 0 ]]; then
    status=1
  fi
  trap - ERR TERM INT
  if [[ "${alias_mutated}" == "true" ]]; then
    set +e
    if [[ "${alias_existed}" == "true" ]]; then
      aws s3 cp "${alias_backup}" "s3://${R2_BUCKET}/${alias_key}" \
        --endpoint-url "${endpoint_url}" \
        --no-progress \
        --content-type application/vnd.android.package-archive \
        --cache-control "no-cache"
    else
      aws s3 rm "s3://${R2_BUCKET}/${alias_key}" \
        --endpoint-url "${endpoint_url}" \
        --no-progress
    fi
    rollback_status="$?"
    set -e
    if [[ "${rollback_status}" -ne 0 ]]; then
      echo "Failed to restore the previous Android alias after metadata publication failed" >&2
    fi
  fi
  exit "${status}"
}
trap rollback_alias ERR TERM INT

alias_mutated=true
aws s3 cp "${apk_path}" "s3://${R2_BUCKET}/${alias_key}" \
  --endpoint-url "${endpoint_url}" \
  --no-progress \
  --content-type application/vnd.android.package-archive \
  --cache-control "no-cache"

aws s3 cp mobile-android-release/version.json "s3://${R2_BUCKET}/${metadata_key}" \
  --endpoint-url "${endpoint_url}" \
  --no-progress \
  --content-type application/json \
  --cache-control "no-cache"

alias_mutated=false
trap - ERR TERM INT
