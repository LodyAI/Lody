#!/usr/bin/env bash
set -euo pipefail

archive_path="${1:-${RUNNER_TEMP}/Lody.xcarchive}"
app="${archive_path}/Products/Applications/App.app"

if [[ ! -d "${app}" ]]; then
  echo "Missing archived iOS app at ${app}"
  exit 1
fi

passkey_enabled="$(/usr/libexec/PlistBuddy -c 'Print LodyPasskeyEnabled' "${app}/Info.plist" 2>/dev/null || true)"
if [[ "${passkey_enabled}" != "YES" ]]; then
  echo "Expected Info.plist LodyPasskeyEnabled=YES, got ${passkey_enabled:-empty}"
  exit 1
fi

verify_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/ios-passkey-verify.XXXXXX")"
trap 'rm -rf "${verify_dir}"' EXIT

app_ent="${verify_dir}/app-entitlements.plist"
codesign -d --entitlements - --xml "${app}" 2>/dev/null > "${app_ent}"
associated_domains="$(/usr/libexec/PlistBuddy -c 'Print com.apple.developer.associated-domains' "${app_ent}" 2>/dev/null || true)"
if ! grep -qF 'webcredentials:lody.ai' <<< "${associated_domains}"; then
  echo "Archived App.app missing webcredentials:lody.ai in com.apple.developer.associated-domains"
  exit 1
fi

for ext in OneSignalNotificationServiceExtension.appex LodyLiveActivityWidget.appex; do
  ext_path="${app}/PlugIns/${ext}"
  if [[ ! -d "${ext_path}" ]]; then
    echo "Missing archived iOS extension: ${ext_path}"
    exit 1
  fi
  ext_ent="${verify_dir}/${ext}-entitlements.plist"
  codesign -d --entitlements - --xml "${ext_path}" 2>/dev/null > "${ext_ent}"
  if /usr/libexec/PlistBuddy -c 'Print com.apple.developer.associated-domains' "${ext_ent}" >/dev/null 2>&1; then
    echo "Extension ${ext} unexpectedly received com.apple.developer.associated-domains"
    exit 1
  fi
done

echo "Verified iOS Passkey archive (LodyPasskeyEnabled=YES, webcredentials:lody.ai scoped to App target only)"
