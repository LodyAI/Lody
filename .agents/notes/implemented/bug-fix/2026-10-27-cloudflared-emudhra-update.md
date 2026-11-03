# cloudflared security release pin

Status: implemented
Translation: current
中文：[2026-10-27-cloudflared-emudhra-update.zh.md](2026-10-27-cloudflared-emudhra-update.zh.md)

## Abstract

Cloudflare's eMudhra intermediate-certificate response requires cloudflared 2026.10.2 or newer, with a newer macOS floor for non-Homebrew installations. The CLI's managed Quick Tunnel still pinned 2026.9.1, so the native artifacts and bundled notices are updated together to 2026.10.4. The existing version-scoped installation cache and executable integrity checks remain unchanged; deployment of matching artifacts on the public runtime channel remains a separate operational prerequisite.

## Decision and evidence

- Pin the five distinct [2026.10.4 release assets](https://github.com/cloudflare/cloudflared/releases/tag/2026.10.4), with Windows ARM64 retaining its explicit AMD64 fallback. Use **archive** hashes for `.tgz` downloads and direct binary hashes elsewhere. All five downloaded SHA256 values matched GitHub's asset metadata.
- The release body lists hashes of **extracted macOS executables** under `.tgz` names, not the downloaded archive hashes. This follows `github_release.py`'s extraction before checksum publication. Pinning the body values would reject authentic downloads.
- `go version -m` on all five artifacts reports Go 1.27.3 and the same tagged main-module revision (`dc3b264da64a801bc3a8d5301a6db21401910ad5`), with a modified-tree marker. Recollect `go-licenses/v2@v2.0.1 save ./cmd/cloudflared` for each GOOS/GOARCH/CGO variant and regenerate the installed notice bundle from checksum-verified Go 1.27.3 source.
- No migration of old versioned installations is necessary: `ensureCloudflaredBinary` selects `<root>/<manifest.version>/<platform>` and verifies the cached executable and notice text on reuse. Existing corrupt/incomplete installations still fail explicitly.
- Quick Tunnel's managed origin is a loopback HTTP proxy. Any external HTTPS Origin using compromised eMudhra intermediates must be checked independently by its owner before replacing a deployed tunnel connector; Lody cannot infer those certificates from its pinned binary.

## Verification and limits

The five focused downloader, process lifecycle and Quick Tunnel suites passed (50 tests); the notice generator's test passed. Linux x64 is the only locally executable official native binary in the current environment; macOS and Windows native execution require platform CI. A direct Linux Quick Tunnel attempt reached the allocation request but failed on the environment's DNS lookup of `api.trycloudflare.com`, so no public origin was exercised. `go-licenses` reports assembly/non-Go sources it cannot inspect, and the compiled dirty-tree marker prevents a full reproducible-build assertion. On October 27, the public runtime channel returned HTTP 200 for the old `2026.9.1/linux-x64` path but HTTP 404 for `2026.10.4/linux-x64`. **Upload and independently validate the new immutable artifacts before making this CLI pin available to users.**
