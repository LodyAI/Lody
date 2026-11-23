#!/bin/sh
# Official standalone daemon installer. Keep execution inside main so incomplete
# downloads never run a partially received installation procedure.
main() {
  set -eu
  channel=stable
  auth=
  start=true
  replace=false
  no_modify_path=false
  base=${LODY_INSTALL_BASE_URL:-}
  [ -n "$base" ] || base='__LODY_INSTALL_ORIGIN__'
  usage='Usage: install.sh [--channel stable|next|nightly] [--auth <pairing credential>] [--replace] [--no-start] [--no-modify-path]

Installs the Lody daemon for this user, signs in and starts it.
  --channel   Release channel (default: stable)
  --auth      Connect this machine with a pairing credential from Lody
  --replace   Stop a running Lody (daemon, desktop app or terminal) without asking
  --no-start  Only install; do not sign in, start or register autostart
  --no-modify-path  Install the lody command without changing PATH or shell profiles'
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --channel) [ "$#" -ge 2 ] || { echo 'Missing channel' >&2; exit 1; }; channel=$2; shift 2 ;;
      --auth) [ "$#" -ge 2 ] || { echo 'Missing pairing credential' >&2; exit 1; }; auth=$2; shift 2 ;;
      --replace) replace=true; shift ;;
      --no-start) start=false; shift ;;
      --no-modify-path) no_modify_path=true; shift ;;
      -h|--help) echo "$usage"; exit 0 ;;
      *) printf 'Unknown option: %s\n\n%s\n' "$1" "$usage" >&2; exit 1 ;;
    esac
  done
  [ "$start" = true ] || [ -z "$auth" ] || { echo '--auth connects and starts this machine; it cannot be combined with --no-start.' >&2; exit 1; }
  case "$channel" in stable|next|nightly) ;; *) echo 'Unsupported release channel' >&2; exit 1 ;; esac
  case "$base" in https://*) protocols='=https' ;; http://127.0.0.1|http://localhost|'http://[::1]') protocols='=http,https' ;; http://127.0.0.1:*|http://localhost:*|'http://[::1]':*) port=${base##*:}; case "$port" in ''|*[!0-9]*) echo 'Invalid loopback installer origin' >&2; exit 1 ;; esac; protocols='=http,https' ;; *) echo 'Installer origin must use HTTPS' >&2; exit 1 ;; esac
  base=${base%/}
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo 'Use the PowerShell installer on Windows; this OS is unsupported.' >&2; exit 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo 'Unsupported CPU architecture' >&2; exit 1 ;; esac
  platform=$os-$arch
  if command -v sha256sum >/dev/null 2>&1; then hash_tool=sha256sum
  elif command -v shasum >/dev/null 2>&1; then hash_tool=shasum
  elif command -v openssl >/dev/null 2>&1; then hash_tool=openssl
  else echo 'A SHA-256 tool (sha256sum, shasum or openssl) is required.' >&2; exit 1; fi
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/lody-install.XXXXXXXX")
  trap 'rm -rf "$tmp"' 0
  trap 'exit 1' 1 2 15
  fetch() {
    curl -fsSL --proto "$protocols" --proto-redir '=https' --connect-timeout 15 --max-time 600 --retry 2 --max-filesize "$3" "$1" -o "$2"
  }
  fail() { echo "$1" >&2; exit 1; }
  sha() {
    case "$hash_tool" in
      sha256sum) sha256sum < "$1" | awk '{print $1}' ;;
      shasum) shasum -a 256 < "$1" | awk '{print $1}' ;;
      openssl) openssl dgst -sha256 "$1" | awk '{print $NF}' ;;
    esac
  }
  fetch "$base/api/install/daemon/$channel/$platform" "$tmp/release" 131072
  {
    IFS= read -r format || fail 'Incomplete release metadata'
    IFS= read -r product || fail 'Incomplete release metadata'
    IFS= read -r distribution || fail 'Incomplete release metadata'
    IFS= read -r version || fail 'Incomplete release metadata'
    IFS= read -r release_channel || fail 'Incomplete release metadata'
    IFS= read -r release_platform || fail 'Incomplete release metadata'
    IFS= read -r file || fail 'Incomplete release metadata'
    IFS= read -r archive_sha || fail 'Incomplete release metadata'
    IFS= read -r archive_size || fail 'Incomplete release metadata'
    IFS= read -r content_sha || fail 'Incomplete release metadata'
    IFS= read -r content_size || fail 'Incomplete release metadata'
    if IFS= read -r extra; then fail 'Unexpected release metadata'; fi
  } < "$tmp/release"
  [ "$format" = LODY-DAEMON-INSTALL-1 ] && [ "$product" = lody-cloud ] && [ "$release_channel" = "$channel" ] && [ "$release_platform" = "$platform" ] && [ "$file" = daemon.gz ] || fail 'Release identity mismatch'
  expected_distribution=lody-cloud-daemon
  [ "$channel" != next ] || expected_distribution=lody-cloud-next-daemon
  [ "$distribution" = "$expected_distribution" ] || fail 'Release distribution mismatch'
  case "$version" in ''|*[!A-Za-z0-9.-]*|[!0-9]*|*..*) fail 'Invalid release version' ;; esac
  for value in "$archive_sha" "$content_sha"; do
    [ "${#value}" -eq 64 ] || fail 'Invalid SHA-256'
    case "$value" in *[!a-f0-9]*) fail 'Invalid SHA-256' ;; esac
  done
  for value in "$archive_size" "$content_size"; do
    case "$value" in ''|*[!0-9]*|0*) fail 'Invalid release size' ;; esac
    [ "${#value}" -le 10 ] && [ "$value" -le 1073741824 ] || fail 'Oversized release'
  done
  release_base=$base/api/runtimes/$distribution/$version/$platform
  echo "Downloading Lody $version for $platform..."
  fetch "$release_base/daemon.gz" "$tmp/daemon.gz" "$archive_size"
  [ "$(wc -c < "$tmp/daemon.gz" | tr -d ' ')" = "$archive_size" ] && [ "$(sha "$tmp/daemon.gz")" = "$archive_sha" ] || fail 'Downloaded archive failed SHA-256/size verification'
  gzip -dc "$tmp/daemon.gz" > "$tmp/daemon"
  [ "$(wc -c < "$tmp/daemon" | tr -d ' ')" = "$content_size" ] && [ "$(sha "$tmp/daemon")" = "$content_sha" ] || fail 'Executable failed SHA-256/size verification'
  chmod 700 "$tmp/daemon"
  fetch "$release_base/node.gz" "$tmp/node.gz" 536870912
  # The verified capsule independently checks this Node archive against embedded
  # compressed and extracted identities before installing it in the digest cache.
  "$tmp/daemon" __sea-install-node "$tmp/node.gz"
  if [ "$start" = true ]; then
    set -- daemon install --start --autostart
    [ -z "$auth" ] || set -- "$@" --auth "$auth"
  else
    set -- daemon install
  fi
  [ "$replace" != true ] || set -- "$@" --replace
  [ "$no_modify_path" != true ] || set -- "$@" --no-modify-path
  # stdin is this script when piped from curl; questions go to the terminal instead.
  if ( : < /dev/tty ) 2>/dev/null; then
    "$tmp/daemon" "$@" < /dev/tty
  else
    "$tmp/daemon" "$@"
  fi
}
main "$@"
