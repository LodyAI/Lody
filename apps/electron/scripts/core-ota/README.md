# Core OTA publisher

Standalone Node ESM publisher for the [Core OTA intent](../../../../specs/portable-desktop-ota.zh.md).
Requires a Node version with native `node:zlib` zstd support and the repository's supported security floor.

| Entry | Contract |
| --- | --- |
| `protocol.mjs` | Canonical serialization, SHA-256, strict schema validation and Ed25519 authentication |
| `build.mjs` | Directory snapshot to signed complete target and immutable objects pack |
| `protocol.test.mjs` | Real crypto, filesystem and zstd boundary tests |

Run from the repository root:

```sh
node apps/electron/scripts/core-ota/build.mjs --input /build/core --output /build/release --release r5 --seq 5 --channel nightly --platform darwin --arch arm64 --host-abi abi1 --key-file /secure/signing.pem
node --test apps/electron/scripts/core-ota/protocol.test.mjs
```

The output directory must be outside input. Files are created exclusively; use a fresh output directory for each attempt. A failed write can leave unpublished pack files. No upload, feed advancement or network operation occurs. Keep input immutable while building; concurrent modification is unsupported. The caller owns release-ID immutability, sequence allocation and publication ordering.

`buildRelease({input, output, release, seq, channel, platform, arch, hostAbi, keyFile})` returns `{manifest, packs}`; each returned pack is `{path, bytes: Buffer}`. Library callers may supply an Ed25519 `privateKey` instead of `keyFile`. CLI keys are PEM files. Diagnostics never print key material.

The schema has exactly `schemaVersion: 1`, `releaseId`, `seq`, `channel`, `platform`, `arch`, `hostAbi`, `tree`, `packs`, `objects`, `patches`, and `signature`. Tree entries are `{path, sha256, size}`; packs are `{sha256, path, size}`; objects are keyed by uncompressed SHA-256 and contain `{packSha256, offset, length, compressedSha256}`. Patch entries add `fromSha256` and `toSha256` to those frame fields. Their fixed schema semantics are zstd with the exact verified source bytes as dictionary. The builder optionally generates dictionary patches using native Node zstd. Every target hash has a full frame regardless of patches.

`canonicalJson(value)` returns a string: object keys use JavaScript UTF-16 lexical order, arrays preserve order, strings use JSON escaping, integers use decimal notation. Only safe integers are supported; negative zero is rejected. `sha256(bytes)` returns lowercase hex. `validateManifest(manifest)` returns the original object or throws. `signManifest(unsigned, privateKey)` returns a validated signed copy. `verifyManifest(manifest, publicKey)` validates and returns the original object or throws. Keys may be Node KeyObjects or PEM inputs. Signature is canonical Base64 Ed25519 over UTF-8 canonical JSON with only the top-level signature removed. Verification does not normalize paths, insert defaults or reorder arrays.

Wire readers must reject duplicate JSON keys before converting to an object; these object APIs cannot recover duplicates discarded by JSON.parse. Readers must bound raw manifest bytes before parsing. Unknown fields are rejected. Paths must be relative NFC, without Windows device names, traversal, backslashes, controls, forbidden Windows characters or trailing dot/space. Case-folded duplicates and file/ancestor conflicts are rejected. Symlinks and special files are unsupported. Mode bits are not represented; Core content must not depend on executable permission preservation.

Limits are 100,000 files/patches, 256 MiB per target/frame, 64 packs, 8 GiB per pack and 32 GiB logical tree. Sequence and offsets are safe integers; ranges must fit their pack and cannot overlap. Publisher retains input paths rather than all input bytes, processes one target/base pair at a time, and buffers compressed frames plus the concatenated returned pack. Provision memory for that pair, replay output and twice the compressed pack size. The library defaults to a 256 MiB compressed-pack budget; `maxPackBytes` may explicitly raise it up to the wire limit. This is not a streaming large-artifact builder. Stable input and Node/zstd toolchain produce deterministic output; compression across toolchain versions is not promised.

Consumers must authenticate before use, enforce channel/platform/architecture/exact Host ABI and sequence policy, verify compressed hash before bounded decompression, then target size/hash. Full-pack downloads additionally verify pack hash. Signature validity alone does not provide freshness, anti-rollback persistence, safe staging or activation. HTTP Range, installation, rollback and signed installer behavior belong to the runtime and are not verified by these publisher tests.

Optional `--previous-input /build/previous` (`previousInput` in the library) compares matching relative paths. Changed targets use `zstdCompressSync(target, {dictionary: base})`; patches are retained only when they save more than 256 bytes and exact bounded dictionary replay matches the target. Missing previous files omit that patch. Invalid previous file types and escaping links fail the build. All target objects retain dictionary-free full frames. Identical existing output bytes are accepted on retry; different bytes fail rather than overwrite immutable artifacts.
