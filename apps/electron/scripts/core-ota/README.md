# Core OTA

Standalone Node ESM publisher for the [Core OTA intent](../../../../specs/portable-desktop-ota.zh.md).
Requires a Node version with native `node:zlib` zstd support and the repository's supported security floor.

| Entry               | Contract                                                                              |
| ------------------- | ------------------------------------------------------------------------------------- |
| `protocol.mjs`      | Canonical serialization, SHA-256, strict schema validation and Ed25519 authentication |
| `build.mjs`         | Directory snapshot to signed complete target and immutable objects pack               |
| `protocol.test.mjs` | Real crypto, filesystem and zstd boundary tests                                       |
| `download.mjs`      | Bounded Range planning, dictionary fallback and complete snapshot staging             |
| `activation.mjs`    | ABI-scoped release adoption, durable pointers and attempt-bound health                |
| `bootstrap.mjs`     | Installed metadata admission and verified external entry selection                    |

Run from the repository root:

```sh
node apps/electron/scripts/core-ota/build.mjs --input /build/core --output /build/release --release r5 --seq 5 --channel nightly --platform darwin --arch arm64 --host-abi abi1 --key-file /secure/signing.pem
node --test apps/electron/scripts/core-ota/protocol.test.mjs
```

The output directory must be outside input. New files are created exclusively; retries accept identical bytes and reject conflicting artifacts. A failed write can leave unpublished pack files. No upload, feed advancement or network operation occurs. Keep input immutable while building; concurrent modification is unsupported. The caller owns release-ID immutability, sequence allocation and publication ordering.

`buildRelease({input, output, release, seq, channel, platform, arch, hostAbi, keyFile})` returns `{manifest, packs}`; each returned pack is `{path, bytes: Buffer}`. Library callers may supply an Ed25519 `privateKey` instead of `keyFile`. CLI keys are PEM files. Diagnostics never print key material.

The schema has exactly `schemaVersion: 1`, `releaseId`, `seq`, `channel`, `platform`, `arch`, `hostAbi`, `tree`, `packs`, `objects`, `patches`, and `signature`. Tree entries are `{path, sha256, size}`; packs are `{sha256, path, size}`; objects are keyed by uncompressed SHA-256 and contain `{packSha256, offset, length, compressedSha256}`. Patch entries add `fromSha256` and `toSha256` to those frame fields. Their fixed schema semantics are zstd with the exact verified source bytes as dictionary. The builder optionally generates dictionary patches using native Node zstd. Every target hash has a full frame regardless of patches.

`canonicalJson(value)` returns a string: object keys use JavaScript UTF-16 lexical order, arrays preserve order, strings use JSON escaping, integers use decimal notation. Only safe integers are supported; negative zero is rejected. `sha256(bytes)` returns lowercase hex. `validateManifest(manifest)` returns the original object or throws. `signManifest(unsigned, privateKey)` returns a validated signed copy. `verifyManifest(manifest, publicKey)` validates and returns the original object or throws. Keys may be Node KeyObjects or PEM inputs. Signature is canonical Base64 Ed25519 over UTF-8 canonical JSON with only the top-level signature removed. Verification does not normalize paths, insert defaults or reorder arrays.

Wire readers must reject duplicate JSON keys before converting to an object; these object APIs cannot recover duplicates discarded by JSON.parse. Readers must bound raw manifest bytes before parsing. Unknown fields are rejected. Paths must be relative NFC, without Windows device names, traversal, backslashes, controls, forbidden Windows characters or trailing dot/space. Case-folded duplicates and file/ancestor conflicts are rejected. Symlinks and special files are unsupported. Mode bits are not represented; Core content must not depend on executable permission preservation.

Limits are 100,000 files/patches, 256 MiB per target/frame, 64 packs, 8 GiB per pack and 32 GiB logical tree. Sequence and offsets are safe integers; ranges must fit their pack and cannot overlap. Publisher retains input paths rather than all input bytes, processes one target/base pair at a time, and buffers compressed frames plus the concatenated returned pack. Provision memory for that pair, replay output and twice the compressed pack size. The library defaults to a 256 MiB compressed-pack budget; `maxPackBytes` may explicitly raise it up to the wire limit. This is not a streaming large-artifact builder. Stable input and Node/zstd toolchain produce deterministic output; compression across toolchain versions is not promised.

Consumers must authenticate before use, enforce channel/platform/architecture/exact Host ABI and sequence policy, verify compressed hash before bounded decompression, then target size/hash. Full-pack downloads additionally verify pack hash. Signature validity alone does not provide freshness, anti-rollback persistence, safe staging or activation. HTTP Range, installation, rollback and signed installer behavior belong to the runtime and are not verified by these publisher tests.

Optional `--previous-input /build/previous` (`previousInput` in the library) compares matching relative paths. Changed targets use `zstdCompressSync(target, {dictionary: base})`; patches are retained only when they save more than 256 bytes and exact bounded dictionary replay matches the target. Missing previous files omit that patch. Invalid previous file types and escaping links fail the build. All target objects retain dictionary-free full frames. Identical existing output bytes are accepted on retry; different bytes fail rather than overwrite immutable artifacts.

## Transfer and activation

`stageRelease({manifest, publicKey, hostAbi, channel, platform, arch, baseUrl, storeRoot, localRoots, fetchImpl, signal})` authenticates applicability before work and returns `{directory, manifest, stats}`. The directory contains only target files; the manifest is returned separately. The transfer planner compares mixed dictionary/object ranges, complete-object ranges and full packs using compressed bytes and request latency. Local content is hashed before reuse. Each downloaded frame and decoded object is verified; HTTP 200 fallback verifies the full pack. Transfers retain at most 512 MiB of content/range buffers and fail when the budget cannot accommodate a target. Persistent byte resume is unavailable.

`openActivation({root, installed, publicKey, lease})` requires the installed Host's exclusive process lease. `adoptStaged({directory, manifest})` verifies the source, copies and verifies the complete snapshot, flushes and seals it, publishes it, and persists `staged`. `begin()` promotes only on the next launch and records an attempt before external execution. `acknowledge({releaseId, attemptId})` accepts only that attempt. A later process rejects an interrupted attempt and verifies the retained candidate before using it; builtin remains the final fallback. Pointer replacement syncs both file and directory. Filesystem flush guarantees still depend on the platform.

The namespace includes product, channel, platform, architecture and Host ABI. The owner is the installed application's single-instance lock, not a PID file or time-based takeover. These modules assume a same-user store; permissions and repeated verification do not isolate downloaded code from another malicious process with the same user rights.

Run the owning behavioral suites:

```sh
node --test apps/electron/scripts/core-ota/*.test.mjs
```

They exercise signed dictionary replay, real loopback HTTP ranges, skipped releases, content reuse, tampering, cancellation, concurrent snapshot publication, durable process restart and stale health rejection. They do not establish packaged Electron execution, signed installer behavior, production publication, power-loss recovery or complete specification conformance.

## Installed desktop integration

Package with `pnpm --dir apps/electron run package -- --core-ota-config /path/to/public-config.json` and the existing explicit publish-policy arguments. The JSON contains only `{product, channel, platform, arch, publicKey, feedUrl}`: product is `lody-oss`, channel matches the packaged stable/nightly version, platform and architecture match the build, publicKey is an Ed25519 PEM public key, and feedUrl is HTTPS without credentials. The packager computes hostAbi from the installed build, dependency lock, public configuration and Host modules after native staging. The resulting `resources/core-ota-host.json` is part of the signed installation. Signing private keys belong only to the artifact publisher.

The feed URL serves the signed manifest. Upload digest-named packs before advancing that manifest. Build Core input with `out/main/application.js`, its relative chunks, `out/preload` and `out/renderer`; retain their build-relative layout. Read hostAbi from the installation's metadata for publication. Core updates use relaunch through the current unload/CLI quit barrier. The installed index keeps identity, single-instance admission and startup custody. A scoped Node loader hook resolves external packages from the installed Host while relative Core imports stay in the verified release. Main-window mainFrame mount confirms the selected release/attempt. Missing metadata, absent releases and incompatible Host targets leave the native full updater available.

The integration suite is `node --test apps/electron/src/main/services/core-updater-service.test.mjs`. It loads signed synthetic application modules, including a CommonJS relative chunk using a Host-only package in a subprocess, and checks retained content reuse across publications. These are Node boundary tests; actual Vite artifacts, Electron's ASAR resolution, native addons and renderer/preload startup require packaged probes on supported architectures.

The current implementation has not established full acceptance of the linked specification. Live health-timeout rescue, in-place renderer reload, bounded retention/GC, rollout policy, data-schema rollback coordination, production publication automation and native installer delta-chain acceptance remain outside this implementation. Recovery after an unacknowledged attempt is exercised on a later process start. No production feed is enabled by default. The specification remains the acceptance target; code presence and these boundary tests do not replace application-level evidence.
