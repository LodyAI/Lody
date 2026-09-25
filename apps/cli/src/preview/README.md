# Managed cloudflared lifecycle and distribution

## Process ownership

```text
CLI / QuickTunnelSession
  └─ cloudflared-worker.js (private IPC ownership)
       └─ pinned native cloudflared + temporary config
```

`cloudflared-process.ts` launches the lightweight owner and interprets its typed
origin/diagnostic/error messages. `cloudflared-worker.ts` releases resources on
an IPC stop request, parent disconnect or termination signal; `cloudflared-native.ts`
owns native startup/log parsing and bounded TERM → KILL escalation. There is no
polling, process discovery, persistent PID state, automatic restart or dev-server
ownership. Session readiness, idle timeout and endpoint credentials stay in the CLI.
The trade-off is one additional Node process per live tunnel, rather than a shared
watchdog with a registry and cross-session failure policy.

Normal shutdown keeps IPC open until error reporting is complete. Completion means
the lifecycle owner's OS exit after native exit and config removal, not merely
that shutdown was requested. A disconnected parent cannot receive cleanup errors.
The owner itself being forcibly killed is outside this parent-disconnect guarantee.

Public, Cloud and development bundles emit the same sibling worker entry. Source
integration fixtures explicitly build that entry in their scratch directory;
production never falls back to TypeScript execution. POSIX process tests cover
normal stop, CLI SIGKILL during creation/active use, native crash, missing binaries
and cleanup failure. Native verification on other operating systems is separate.

## Distribution

`cloudflared-manifest.json` pins upstream release artifacts. The downloader uses
the public runtime channel, checks their bytes, and atomically installs an
executable with `THIRD_PARTY_NOTICES.txt`. The notices come from a static JSON
import in `cloudflared-binary.ts`, so source, bundled CLI and embedded CLI use the
same text without a second asset-copy pipeline. Existing incomplete installations
are errors, not repair or migration inputs.

## Updating notices with the pinned release

The generated JSON contains exact collected license/notice text, the release URL,
all release Go versions, and source `go.mod`/`go.sum` hashes. Do not edit individual generated
license texts. Changing the manifest version also requires regenerating notices;
the binary helper rejects mismatched release metadata.

1. Check out the matching upstream source and inspect the downloaded binaries
   using `go version -m -json <binary>`. Match their Go version and compiled module
   paths, versions, checksums and replacements against the source dependency graph.
2. Use `github.com/google/go-licenses/v2@v2.0.1` with the pinned module graph. From the
   upstream source directory, collect `go-licenses save ./cmd/cloudflared
--save_path=<output-dir>` for each row below, setting `GOOS`, `GOARCH` and
   `CGO_ENABLED`. Save each output in a separate directory. Do not reuse an output
   from another release.
3. Review tool warnings and non-Go sources separately. The collector cannot prove
   that assembly/C or dynamically linked libraries have no additional obligations.
4. Obtain the source for every Go version reported by the artifacts, verifying
   official archive checksums. Include each root's runtime and vendor notices;
   do not infer the release's toolchain from the current machine's binary alone.
   From the public repository, run:

   ```sh
   node scripts/generate-cloudflared-notices.mjs <upstream-source-dir> <go-source-dir>... -- <darwin-arm64-notices> <darwin-amd64-notices> <linux-amd64-notices> <linux-arm64-notices> <windows-amd64-notices>
   node --test scripts/generate-cloudflared-notices.test.mjs
   ```

5. Inspect the generated diff, run the binary install tests and rebuild the CLI.
   Notice conflicts across platforms or same-version Go roots fail generation
   rather than choosing one. The installed notice heading lists release toolchains,
   not a single toolchain claimed for every platform.

| GOOS    | GOARCH | CGO_ENABLED | Artifact Go version | Module dependencies |
| ------- | ------ | ----------- | ------------------- | ------------------- |
| darwin  | arm64  | 1           | 1.26.2              | 66                  |
| darwin  | amd64  | 1           | 1.26.2              | 66                  |
| linux   | amd64  | 0           | 1.26.8              | 67                  |
| linux   | arm64  | 0           | 1.26.8              | 67                  |
| windows | amd64  | 1           | 1.26.8              | 66                  |

Windows ARM64 uses the same pinned Windows AMD64 artifact; it does not introduce
another dependency graph. Native execution on supported platforms is a separate
acceptance requirement.

## Current evidence and limits

The 2026.9.1 collection merges 100 notice files from the five platform selections
and both Go source roots. A cross-platform metadata audit corrected the original
single-Go-version assumption and Windows CGO setting; Windows notices were
recollected with CGO enabled. Module collection used Go 1.26.2; exact runtime/vendor
texts also come from checksum-verified Go 1.26.8 source.

All five distinct artifact checksums, module versions/checksums/replacements and
at least one collected notice's exact source bytes per compiled module were
verified against the tag's 159-module graph. `go-licenses` labels some inherited
root licenses by package import path; replacements retain the original import
path label but must match the replacement source's license text.

All five report dirty main-module revision `f11dea9cb7079e90a982c1a2d5548ab40847fdcf`,
different from the source tag: dependency agreement does not prove an identical
source build. Non-Go warnings and native linkage still need review before
publication. The generated text is not a claim that every distribution obligation
has been independently verified.

Behavioral tests check deterministic collection, platform conflicts, source
license mismatch, installed text, cache reuse and explicit rejection of missing
or modified cached notices.
