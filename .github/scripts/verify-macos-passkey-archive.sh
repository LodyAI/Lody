#!/usr/bin/env bash
set -euo pipefail

version="$(node -p "require('./apps/electron/package.json').version")"
if [[ -z "${version}" ]]; then
  echo "Could not resolve Electron version from apps/electron/package.json"
  exit 1
fi

verify_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/macos-passkey-verify.XXXXXX")"
trap 'rm -rf "${verify_dir}"' EXIT

for arch in arm64 x64; do
  macho_arch="${arch}"
  if [[ "${arch}" == "x64" ]]; then
    macho_arch="x86_64"
  fi

  archive="apps/electron/dist/Lody-${version}-${arch}.zip"
  if [[ ! -f "${archive}" ]]; then
    echo "Missing macOS Electron archive: ${archive}"
    exit 1
  fi

  extract_dir="${verify_dir}/${arch}"
  mkdir -p "${extract_dir}"
  ditto -x -k "${archive}" "${extract_dir}"

  app="${extract_dir}/Lody.app"
  if [[ ! -d "${app}" ]]; then
    echo "Missing Lody.app inside ${archive}"
    exit 1
  fi

  codesign --verify --deep --strict -R='anchor apple generic' "${app}"
  xcrun stapler validate "${app}"

  if [[ ! -f "${app}/Contents/embedded.provisionprofile" ]]; then
    echo "Missing Contents/embedded.provisionprofile in ${app}"
    exit 1
  fi

  # codesign, notarization and Gatekeeper accept an app whose embedded profile does
  # not authorize its signature; AMFI then kills it at launch on every Mac.
  node apps/electron/passkey-packaging.mjs "${app}"
  if [[ "$(uname -m)" == "${macho_arch}" ]] &&
    ! ELECTRON_RUN_AS_NODE=1 "${app}/Contents/MacOS/Lody" -e 'process.exit(0)'; then
    echo "macOS refused to launch Lody.app (${arch}); see the amfid and taskgated-helper logs"
    exit 1
  fi

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
    echo "Lody.app (${arch}) missing webcredentials:lody.ai in com.apple.developer.associated-domains"
    exit 1
  fi

  app_id="$(/usr/libexec/PlistBuddy -c 'Print com.apple.application-identifier' "${app_ent}" 2>/dev/null || true)"
  if [[ "${app_id}" != "YTRMX32C99.ai.lody.desktop" ]]; then
    echo "Lody.app (${arch}) application-identifier mismatch: ${app_id:-empty}"
    exit 1
  fi

  team_id="$(/usr/libexec/PlistBuddy -c 'Print com.apple.developer.team-identifier' "${app_ent}" 2>/dev/null || true)"
  if [[ "${team_id}" != "YTRMX32C99" ]]; then
    echo "Lody.app (${arch}) team-identifier mismatch: ${team_id:-empty}"
    exit 1
  fi

  if /usr/libexec/PlistBuddy -c 'Print com.apple.security.cs.disable-library-validation' "${app_ent}" >/dev/null 2>&1; then
    echo "Lody.app (${arch}) unexpectedly has com.apple.security.cs.disable-library-validation"
    exit 1
  fi

  helper="${app}/Contents/Frameworks/Lody Helper.app"
  if [[ ! -d "${helper}" ]]; then
    echo "Missing helper bundle: ${helper}"
    exit 1
  fi
  helper_ent="${verify_dir}/${arch}-helper-entitlements.plist"
  codesign -d --entitlements - --xml "${helper}" 2>/dev/null > "${helper_ent}"
  if /usr/libexec/PlistBuddy -c 'Print com.apple.developer.associated-domains' "${helper_ent}" >/dev/null 2>&1; then
    echo "Lody Helper.app (${arch}) unexpectedly inherited com.apple.developer.associated-domains"
    exit 1
  fi
done

echo "Verified signed macOS Passkey archives for arm64 and x64 (${version})"
