#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${MACOS_PASSKEY_PROVISIONING_PROFILE_BASE64:-}" ]]; then
  echo "Missing required MACOS_PASSKEY_PROVISIONING_PROFILE_BASE64 secret for production macOS Passkey packaging"
  exit 1
fi
if [[ -z "${CSC_LINK:-}" || -z "${CSC_KEY_PASSWORD:-}" ]]; then
  echo "Missing required CSC_LINK or CSC_KEY_PASSWORD to verify macOS Passkey provisioning profile against the signing certificate"
  exit 1
fi

profile_path="${RUNNER_TEMP}/macos-passkey.provisionprofile"
work_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/macos-passkey-prepare.XXXXXX")"
trap 'rm -rf "${work_dir}"' EXIT
umask 077

encoded_path="${work_dir}/profile.base64"
plist_path="${work_dir}/profile.plist"
p12_encoded_path="${work_dir}/signing.p12.base64"
p12_path="${work_dir}/signing.p12"
cert_pem_path="${work_dir}/signing-cert.pem"

printf '%s' "${MACOS_PASSKEY_PROVISIONING_PROFILE_BASE64}" |
  sed -e 's/\\n//g' -e 's/\\r//g' |
  tr -d '[:space:]' > "${encoded_path}"

if [[ ! -s "${encoded_path}" ]]; then
  echo "MACOS_PASSKEY_PROVISIONING_PROFILE_BASE64 is empty after removing whitespace"
  exit 1
fi

if ! openssl base64 -A -d -in "${encoded_path}" -out "${profile_path}"; then
  rm -f "${profile_path}"
  echo "MACOS_PASSKEY_PROVISIONING_PROFILE_BASE64 must contain base64-encoded provisioning profile bytes"
  exit 1
fi

if ! security cms -D -i "${profile_path}" > "${plist_path}"; then
  rm -f "${profile_path}"
  echo "MACOS_PASSKEY_PROVISIONING_PROFILE_BASE64 decoded but is not a valid provisioning profile"
  exit 1
fi

if [[ -f "${CSC_LINK}" ]]; then
  cp "${CSC_LINK}" "${p12_path}"
else
  printf '%s' "${CSC_LINK}" |
    sed -e 's/\\n//g' -e 's/\\r//g' |
    tr -d '[:space:]' > "${p12_encoded_path}"
  if ! openssl base64 -A -d -in "${p12_encoded_path}" -out "${p12_path}"; then
    rm -f "${profile_path}"
    echo "CSC_LINK must be a readable .p12 file or base64-encoded PKCS#12 bytes"
    exit 1
  fi
fi

if ! openssl pkcs12 -in "${p12_path}" -clcerts -nokeys -passin env:CSC_KEY_PASSWORD > "${cert_pem_path}" 2>/dev/null; then
  if ! openssl pkcs12 -legacy -in "${p12_path}" -clcerts -nokeys -passin env:CSC_KEY_PASSWORD > "${cert_pem_path}"; then
    rm -f "${profile_path}"
    echo "Failed to extract signing certificate from CSC_LINK PKCS#12 archive"
    exit 1
  fi
fi

expected_app_id="${LODY_PASSKEY_EXPECTED_APP_ID:-YTRMX32C99.ai.lody.desktop}"

if ! node .github/scripts/macos-passkey-profile.mjs \
  --plist "${plist_path}" \
  --cert-pem "${cert_pem_path}" \
  --app-id "${expected_app_id}"; then
  rm -f "${profile_path}"
  exit 1
fi

addon_dir="${RUNNER_TEMP}/passkey-addons"
rm -rf "${addon_dir}"
node apps/electron/scripts/build-passkey-addons.mjs --out "${addon_dir}" --arches arm64,x64

{
  echo "LODY_ENABLE_PASSKEY=1"
  echo "LODY_PASSKEY_ADDON_DIR=${addon_dir}"
  echo "LODY_PASSKEY_PROVISIONING_PROFILE=${profile_path}"
} >> "$GITHUB_ENV"

echo "Prepared macOS Passkey provisioning profile and native addons (arm64, x64)"
