#!/bin/bash

set -euo pipefail

: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"
: "${GITHUB_ENV:?GITHUB_ENV is required}"
: "${IOS_DIST_CERT_SERIAL:?IOS_DIST_CERT_SERIAL is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${TARGET_BUNDLE_IDS:?TARGET_BUNDLE_IDS is required}"

certificate_serial="$(
  printf '%s' "$IOS_DIST_CERT_SERIAL" |
    tr -d '[:space:]:' |
    tr '[:lower:]' '[:upper:]'
)"
certificates_json="$(
  asc certificates list \
    --certificate-type DISTRIBUTION \
    --paginate \
    --output json
)"
certificate_ids="$(
  jq -c --arg serial "$certificate_serial" \
    '[.data[] |
      select(
        (.attributes.serialNumber | gsub(":"; "") | ascii_upcase) == $serial
      ) |
      .id
    ]' <<< "$certificates_json"
)"
if [ "$(jq 'length' <<< "$certificate_ids")" -ne 1 ]; then
  echo "::error::Expected one App Store Connect distribution certificate with serial $certificate_serial."
  exit 1
fi
certificate_id="$(jq -r '.[0]' <<< "$certificate_ids")"

bundle_ids_json="$(asc bundle-ids list --paginate --output json)"
profiles_json="$(
  asc profiles list \
    --profile-type IOS_APP_STORE \
    --profile-state ACTIVE,INVALID \
    --paginate \
    --output json
)"
profile_map='{}'

while IFS= read -r bundle_identifier; do
  [ -n "$bundle_identifier" ] || continue

  bundle_resource_ids="$(
    jq -c --arg identifier "$bundle_identifier" \
      '[.data[] |
        select(.attributes.identifier == $identifier) |
        .id
      ]' <<< "$bundle_ids_json"
  )"
  if [ "$(jq 'length' <<< "$bundle_resource_ids")" -ne 1 ]; then
    echo "::error::Expected one registered bundle ID for $bundle_identifier."
    exit 1
  fi
  bundle_resource_id="$(jq -r '.[0]' <<< "$bundle_resource_ids")"

  profile_base="$bundle_identifier CI App Store"
  profile_id=''
  candidates="$(
    jq -r --arg name "$profile_base" \
      '.data |
        map(select(
          .attributes.profileState == "ACTIVE" and
          (
            .attributes.name == $name or
            (.attributes.name | startswith($name + " "))
          )
        )) |
        sort_by(.attributes.createdDate) |
        reverse |
        .[].id' <<< "$profiles_json"
  )"
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    details="$(
      asc profiles view \
        --id "$candidate" \
        --include bundleId,certificates \
        --output json
    )"
    matches="$(
      jq -r \
        --arg bundle "$bundle_identifier" \
        --arg serial "$certificate_serial" \
        '(.data.attributes.profileState == "ACTIVE") and
         (any(.included[]?;
           .type == "bundleIds" and .attributes.identifier == $bundle
         )) and
         (any(.included[]?;
           .type == "certificates" and
           ((.attributes.serialNumber | gsub(":"; "") | ascii_upcase) == $serial)
         ))' <<< "$details"
    )"
    if [ "$matches" = 'true' ]; then
      profile_id="$candidate"
      break
    fi
  done <<< "$candidates"

  if [ -z "$profile_id" ]; then
    profile_name="$profile_base ${GITHUB_RUN_ID:-$(date -u +%Y%m%d%H%M%S)}"
    created="$(
      asc profiles create \
        --name "$profile_name" \
        --profile-type IOS_APP_STORE \
        --bundle "$bundle_resource_id" \
        --certificate "$certificate_id" \
        --output json
    )"
    profile_id="$(jq -r '.data.id // ""' <<< "$created")"
    if [ -z "$profile_id" ]; then
      echo "::error::App Store Connect did not return a profile for $bundle_identifier."
      exit 1
    fi
  fi

  profile_path="$RUNNER_TEMP/${bundle_identifier//[^a-zA-Z0-9._-]/_}.mobileprovision"
  asc profiles download --id "$profile_id" --output "$profile_path" >/dev/null
  metadata="$(asc profiles inspect --path "$profile_path" --output json)"
  if ! jq -e \
    --arg bundle "$bundle_identifier" \
    --arg application_id "$APPLE_TEAM_ID.$bundle_identifier" \
    '.bundleId == $bundle and
     .applicationIdentifier == $application_id and
     .expired == false and
     .entitlements["get-task-allow"] == false' \
    <<< "$metadata" >/dev/null; then
    echo "::error::Downloaded profile $profile_id is not a valid App Store profile for $bundle_identifier."
    exit 1
  fi
  uuid="$(jq -r '.uuid // ""' <<< "$metadata")"
  if [ -z "$uuid" ]; then
    echo "::error::Downloaded profile $profile_id has no UUID."
    exit 1
  fi

  for directory in \
    "$HOME/Library/MobileDevice/Provisioning Profiles" \
    "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"; do
    mkdir -p "$directory"
    cp "$profile_path" "$directory/$uuid.mobileprovision"
  done
  profile_map="$(
    jq -c --arg bundle "$bundle_identifier" --arg uuid "$uuid" \
      '. + {($bundle): $uuid}' <<< "$profile_map"
  )"
  echo "Installed $bundle_identifier profile $uuid"
done <<< "$TARGET_BUNDLE_IDS"

if [ "$(jq 'length' <<< "$profile_map")" -eq 0 ]; then
  echo "::error::No iOS signing targets were provided."
  exit 1
fi

invalid_profile_ids="$(
  jq -r \
    '.data[] |
      select(.attributes.profileState == "INVALID") |
      .id' <<< "$profiles_json"
)"
while IFS= read -r invalid_profile_id; do
  [ -n "$invalid_profile_id" ] || continue
  details="$(
    asc profiles view \
      --id "$invalid_profile_id" \
      --include bundleId \
      --output json
  )"
  invalid_bundle="$(
    jq -r \
      '[.included[]? |
        select(.type == "bundleIds") |
        .attributes.identifier
      ] |
      first // ""' <<< "$details"
  )"
  if [ -n "$invalid_bundle" ] &&
     jq -e --arg bundle "$invalid_bundle" 'has($bundle)' \
       <<< "$profile_map" >/dev/null; then
    asc profiles delete --id "$invalid_profile_id" --confirm >/dev/null
    echo "Deleted invalid profile $invalid_profile_id for $invalid_bundle"
  fi
done <<< "$invalid_profile_ids"

echo "IOS_PROFILE_MAP=$profile_map" >> "$GITHUB_ENV"
