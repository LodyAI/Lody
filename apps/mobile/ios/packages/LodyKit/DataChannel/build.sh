#!/bin/bash
# Builds LodyDataChannel.xcframework: libdatachannel (data channels only) over
# libjuice, usrsctp and Mbed TLS, as one static library per iOS slice.
set -euo pipefail

LIBDATACHANNEL_TAG=v0.23.2
LIBDATACHANNEL_COMMIT=9e6a13abbb6846c003d817d0387b6706466e2b03
MBEDTLS_TAG=v3.6.4
MBEDTLS_COMMIT=c765c831e5c2a0971410692f92f7a81d6ec65ec2
DEPLOYMENT_TARGET=26.0

here="$(cd "$(dirname "$0")" && pwd)"
output="$here/../Vendor/LodyDataChannel.xcframework"
work="$here/.build"
stamp="$LIBDATACHANNEL_COMMIT $MBEDTLS_COMMIT $DEPLOYMENT_TARGET $(shasum "$0" | cut -c1-12)"

if [ -f "$output/.stamp" ] && [ "$(cat "$output/.stamp")" = "$stamp" ]; then
  exit 0
fi
command -v cmake >/dev/null || { echo "LodyDataChannel needs cmake (brew install cmake)." >&2; exit 1; }

checkout() { # url tag commit directory
  if [ "$(git -C "$4" rev-parse HEAD 2>/dev/null)" != "$3" ]; then
    rm -rf "$4"
    git clone --quiet --depth 1 --branch "$2" --recurse-submodules --shallow-submodules "$1" "$4"
  fi
  [ "$(git -C "$4" rev-parse HEAD)" = "$3" ] || { echo "$1 $2 is not $3" >&2; exit 1; }
}

mkdir -p "$work"
checkout https://github.com/paullouisageneau/libdatachannel.git "$LIBDATACHANNEL_TAG" "$LIBDATACHANNEL_COMMIT" "$work/libdatachannel"
checkout https://github.com/Mbed-TLS/mbedtls.git "$MBEDTLS_TAG" "$MBEDTLS_COMMIT" "$work/mbedtls"
# DTLS-SRTP is negotiated by libdatachannel's DTLS handshake even without media.
python3 "$work/mbedtls/scripts/config.py" -f "$work/mbedtls/include/mbedtls/mbedtls_config.h" set MBEDTLS_SSL_DTLS_SRTP

slices=()
for sdk in iphoneos iphonesimulator; do
  prefix="$work/$sdk"
  rm -rf "$prefix" "$work/build-$sdk"
  # Generic simulator builds (CI) still request x86_64.
  archs=arm64
  [ "$sdk" = iphonesimulator ] && archs="arm64;x86_64"
  flags=(-DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT="$sdk" -DCMAKE_OSX_ARCHITECTURES="$archs"
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$DEPLOYMENT_TARGET" -DCMAKE_BUILD_TYPE=MinSizeRel
    -DCMAKE_INSTALL_PREFIX="$prefix" -DCMAKE_PREFIX_PATH="$prefix" -DCMAKE_FIND_ROOT_PATH="$prefix")
  cmake "${flags[@]}" -S "$work/mbedtls" -B "$work/build-$sdk/mbedtls" \
    -DENABLE_TESTING=OFF -DENABLE_PROGRAMS=OFF -DMBEDTLS_FATAL_WARNINGS=OFF >/dev/null
  cmake --build "$work/build-$sdk/mbedtls" -j 8 >/dev/null
  cmake --install "$work/build-$sdk/mbedtls" >/dev/null
  cmake "${flags[@]}" -S "$work/libdatachannel" -B "$work/build-$sdk/libdatachannel" \
    -DBUILD_SHARED_LIBS=OFF -DUSE_MBEDTLS=ON -DNO_MEDIA=ON -DNO_WEBSOCKET=ON -DNO_EXAMPLES=ON -DNO_TESTS=ON >/dev/null
  cmake --build "$work/build-$sdk/libdatachannel" -j 8 >/dev/null
  cmake --install "$work/build-$sdk/libdatachannel" >/dev/null
  framework="$prefix/LodyDataChannel.framework"
  mkdir -p "$framework/Headers" "$framework/Modules"
  libtool -static -o "$framework/LodyDataChannel" \
    "$prefix"/lib/{libdatachannel,libjuice,libusrsctp,libmbedtls,libmbedx509,libmbedcrypto}.a 2>/dev/null
  cp "$prefix/include/rtc/rtc.h" "$prefix/include/rtc/version.h" "$framework/Headers/"
  cat > "$framework/Modules/module.modulemap" <<'MAP'
framework module LodyDataChannel {
  umbrella header "rtc.h"
  link "c++"
  export *
}
MAP
  plutil -create xml1 "$framework/Info.plist"
  for pair in CFBundleIdentifier=app.innei.LodyDataChannel CFBundleName=LodyDataChannel \
    CFBundleExecutable=LodyDataChannel CFBundlePackageType=FMWK CFBundleShortVersionString=1.0 \
    CFBundleVersion=1 MinimumOSVersion="$DEPLOYMENT_TARGET"; do
    plutil -insert "${pair%%=*}" -string "${pair#*=}" "$framework/Info.plist"
  done
  slices+=(-framework "$framework")
done

rm -rf "$output"
mkdir -p "$(dirname "$output")"
xcodebuild -create-xcframework "${slices[@]}" -output "$output" >/dev/null
echo "$stamp" > "$output/.stamp"
echo "Built LodyDataChannel.xcframework"
