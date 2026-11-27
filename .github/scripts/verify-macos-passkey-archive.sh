#!/usr/bin/env bash
set -euo pipefail

version="${LODY_PASSKEY_VERSION:-$(node -p "require('./apps/electron/package.json').version")}"
if [[ -z "${version}" ]]; then
  echo "Could not resolve Electron version from apps/electron/package.json"
  exit 1
fi

expected_app_id="${LODY_PASSKEY_EXPECTED_APP_ID:-YTRMX32C99.ai.lody.desktop}"
app_name="${LODY_PASSKEY_APP_NAME:-Lody}"
archive_suffix="${LODY_PASSKEY_ARCHIVE_SUFFIX:-}"

verify_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/macos-passkey-verify.XXXXXX")"
trap 'rm -rf "${verify_dir}"' EXIT

arches="${LODY_PASSKEY_ARCHES:-arm64 x64}"
for arch in ${arches}; do
  macho_arch="${arch}"
  if [[ "${arch}" == "x64" ]]; then
    macho_arch="x86_64"
  fi

  archive="apps/electron/dist/Lody-${version}-${arch}${archive_suffix}.zip"
  if [[ ! -f "${archive}" ]]; then
    echo "Missing macOS Electron archive: ${archive}"
    exit 1
  fi

  extract_dir="${verify_dir}/${arch}"
  mkdir -p "${extract_dir}"
  ditto -x -k "${archive}" "${extract_dir}"

  app="${extract_dir}/${app_name}.app"
  if [[ ! -d "${app}" ]]; then
    echo "Missing ${app_name}.app inside ${archive}"
    exit 1
  fi

  codesign --verify --deep --strict -R='anchor apple generic' "${app}"
  xcrun stapler validate "${app}"
  spctl -a -vvv -t exec "${app}"

  if [[ ! -f "${app}/Contents/embedded.provisionprofile" ]]; then
    echo "Missing Contents/embedded.provisionprofile in ${app}"
    exit 1
  fi

  cert_prefix="${verify_dir}/${arch}-cert"
  codesign -d --extract-certificates="${cert_prefix}" "${app}" 2>/dev/null
  leaf_cert="${cert_prefix}0"
  if [[ ! -s "${leaf_cert}" ]]; then
    echo "Failed to extract leaf signing certificate from ${app}"
    exit 1
  fi

  profile_plist="${verify_dir}/${arch}-embedded-profile.plist"
  if ! security cms -D -i "${app}/Contents/embedded.provisionprofile" > "${profile_plist}"; then
    echo "Failed to decode Contents/embedded.provisionprofile in ${app}"
    exit 1
  fi
  node .github/scripts/macos-passkey-profile.mjs \
    --plist "${profile_plist}" \
    --cert-der "${leaf_cert}" \
    --app-id "${expected_app_id}"

  addon="${app}/Contents/Resources/passkey_bridge.node"
  if [[ ! -f "${addon}" ]]; then
    echo "Missing Contents/Resources/passkey_bridge.node in ${app}"
    exit 1
  fi
  lipo "${addon}" -verify_arch "${macho_arch}"
  codesign --verify --strict "${addon}"

  app_ent="${verify_dir}/${arch}-app-entitlements.plist"
  codesign -d --entitlements - --xml "${app}" 2>/dev/null > "${app_ent}"

  associated_domains="$(/usr/libexec/PlistBuddy -c 'Print com.apple.developer.associated-domains' "${app_ent}" 2>/dev/null || true)"
  if ! grep -qF 'webcredentials:lody.ai' <<< "${associated_domains}"; then
    echo "${app_name}.app (${arch}) missing webcredentials:lody.ai in com.apple.developer.associated-domains"
    exit 1
  fi

  app_id="$(/usr/libexec/PlistBuddy -c 'Print com.apple.application-identifier' "${app_ent}" 2>/dev/null || true)"
  if [[ "${app_id}" != "${expected_app_id}" ]]; then
    echo "${app_name}.app (${arch}) application-identifier mismatch: ${app_id:-empty} (expected ${expected_app_id})"
    exit 1
  fi

  team_id="$(/usr/libexec/PlistBuddy -c 'Print com.apple.developer.team-identifier' "${app_ent}" 2>/dev/null || true)"
  if [[ "${team_id}" != "YTRMX32C99" ]]; then
    echo "${app_name}.app (${arch}) team-identifier mismatch: ${team_id:-empty}"
    exit 1
  fi

  if /usr/libexec/PlistBuddy -c 'Print com.apple.security.cs.disable-library-validation' "${app_ent}" >/dev/null 2>&1; then
    echo "${app_name}.app (${arch}) unexpectedly has com.apple.security.cs.disable-library-validation"
    exit 1
  fi

  helper="${app}/Contents/Frameworks/${app_name} Helper.app"
  if [[ ! -d "${helper}" ]]; then
    echo "Missing helper bundle: ${helper}"
    exit 1
  fi
  helper_ent="${verify_dir}/${arch}-helper-entitlements.plist"
  codesign -d --entitlements - --xml "${helper}" 2>/dev/null > "${helper_ent}"
  if /usr/libexec/PlistBuddy -c 'Print com.apple.developer.associated-domains' "${helper_ent}" >/dev/null 2>&1; then
    echo "${app_name} Helper.app (${arch}) unexpectedly inherited com.apple.developer.associated-domains"
    exit 1
  fi
done

echo "Verified signed macOS Passkey archives for ${arches} (${app_name} ${version})"
