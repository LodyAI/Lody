#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${MACOS_PASSKEY_PROVISIONING_PROFILE_BASE64:-}" ]]; then
  echo "Missing required MACOS_PASSKEY_PROVISIONING_PROFILE_BASE64 secret for production macOS Passkey packaging"
  exit 1
fi

profile_path="${RUNNER_TEMP}/macos-passkey.provisionprofile"
encoded_path="${profile_path}.base64"
plist_path="${profile_path}.plist"

printf '%s' "${MACOS_PASSKEY_PROVISIONING_PROFILE_BASE64}" |
  sed -e 's/\\n//g' -e 's/\\r//g' |
  tr -d '[:space:]' > "${encoded_path}"

if [[ ! -s "${encoded_path}" ]]; then
  rm -f "${encoded_path}"
  echo "MACOS_PASSKEY_PROVISIONING_PROFILE_BASE64 is empty after removing whitespace"
  exit 1
fi

if ! openssl base64 -A -d -in "${encoded_path}" -out "${profile_path}"; then
  rm -f "${encoded_path}" "${profile_path}"
  echo "MACOS_PASSKEY_PROVISIONING_PROFILE_BASE64 must contain base64-encoded provisioning profile bytes"
  exit 1
fi
rm -f "${encoded_path}"

if ! security cms -D -i "${profile_path}" > "${plist_path}"; then
  rm -f "${profile_path}" "${plist_path}"
  echo "MACOS_PASSKEY_PROVISIONING_PROFILE_BASE64 decoded but is not a valid provisioning profile"
  exit 1
fi

associated_domains="$(/usr/libexec/PlistBuddy -c 'Print Entitlements:com.apple.developer.associated-domains' "${plist_path}" 2>/dev/null || true)"
app_id="$(/usr/libexec/PlistBuddy -c 'Print Entitlements:com.apple.application-identifier' "${plist_path}" 2>/dev/null || true)"
team_id="$(/usr/libexec/PlistBuddy -c 'Print Entitlements:com.apple.developer.team-identifier' "${plist_path}" 2>/dev/null || true)"
rm -f "${plist_path}"

if [[ -z "${associated_domains}" ]]; then
  rm -f "${profile_path}"
  echo "macOS Passkey provisioning profile is missing Entitlements:com.apple.developer.associated-domains"
  exit 1
fi
if [[ "${app_id}" != "YTRMX32C99.ai.lody.desktop" ]]; then
  rm -f "${profile_path}"
  echo "macOS Passkey provisioning profile application-identifier mismatch (expected YTRMX32C99.ai.lody.desktop, got ${app_id:-empty})"
  exit 1
fi
if [[ "${team_id}" != "YTRMX32C99" ]]; then
  rm -f "${profile_path}"
  echo "macOS Passkey provisioning profile team-identifier mismatch (expected YTRMX32C99, got ${team_id:-empty})"
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
