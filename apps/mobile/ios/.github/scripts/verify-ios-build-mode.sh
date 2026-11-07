#!/bin/bash
set -euo pipefail

ios_directory="${1:?Usage: verify-ios-build-mode.sh <ios-directory>}"
project="$ios_directory/Lody.xcodeproj/project.pbxproj"
if [ ! -f "$project" ]; then
  echo "::error::Native Xcode project is missing; run pnpm prebuild" >&2
  exit 1
fi
if [ -e "$ios_directory/Pods" ] || [ -e "$ios_directory/Podfile" ]; then
  echo "::error::Stale CocoaPods output in the XcodeGen project: $ios_directory" >&2
  exit 1
fi
if grep -Ei '(React[-./]|ReactAppDependencyProvider|RCTBridge|ExpoModules|Expo[./]|hermes[-.]|Metro|RNReanimated|RNScreens)' "$project"; then
  echo '::error::React Native build reference in the standalone native project' >&2
  exit 1
fi
echo 'Standalone XcodeGen project verified.'
