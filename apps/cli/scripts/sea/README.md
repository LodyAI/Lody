# Managed daemon packaging

The npm bin stays JavaScript. `stage.mjs` gathers the built CLI, file-based Workers,
WASM and target native dependencies. `build.mjs` embeds that complete tree in a
Node 26.13.0 SEA. A fixed installed SEA
runs the existing watchdog and keeps the Host lease; versioned Workers run under
a separately cached, ordinary official Node. SEA cannot interpret external JS.

```text
fixed service (explicit installer only)
  Host lease + durable operation + selected release
    Node by digest → selected CLI Worker
      managed Agent adapters / MCP / ACP / PTY
```

Build the CLI first, then run the scripts with JSON configuration paths:

```sh
pnpm --dir apps/cli build
node apps/cli/scripts/sea/stage.mjs stage.json
node apps/cli/scripts/sea/build.mjs build.json
# When signing, sign native code before build and the completed SEA before finalize.
# macOS signing is required; Windows Authenticode signing is optional.
node apps/cli/scripts/sea/finalize.mjs finalize.json
```

Stage configuration contains `staging`, `dist`, `cliRoot`. Build configuration adds
`output`, `node`, `product` (`lody-oss` or `lody-cloud`), `distribution`, `version`,
`channel` and `platform`. Build on the native target
using the pinned Node. Windows can publish unsigned SEA binaries when no certificate
is configured; macOS still requires platform signing. If signing is configured,
signing failures must stop publication. Finalize configuration contains `capsule`, `node`,
`outputDir`, `source` (full publishing source SHA). Finalize freezes `manifest.json`,
`daemon.gz` and `node.gz` after platform signing. Do not rebuild same-version bytes
on publication retry. The updater trusts the configured HTTPS artifact service for manifests and checks
SHA-256 of compressed and extracted files. These hashes detect corruption; they
do not authenticate a manifest replaced along with its artifacts. No release
key pair is required. OSS and cloud retain separate product/distribution checks.

The installer extracts to the existing installation-profile data directory and
fetches the additional Node from the public artifact store, checking the exact
compressed/raw identities embedded in the SEA. `LODY_RUNTIME_BASE_URL` is an explicit
mirror override; normal service startup never downloads implicitly. The fixed
service path is registered locally, not rewritten on each version switch. Addons
are extracted without modifying signed bytes; preparation probes this same digest
directory in both SEA and ordinary Node. macOS requires the platform's Node floor
(13.5 for this pin); Linux requires kernel 4.18, glibc 2.28 and GLIBCXX_3.4.25 or
newer, plus any stricter addon requirement. musl is excluded.

Release `serviceProtocol: 1` and `dataFormat: 1` mean compatible process and storage
contracts. A release changing existing-store schemas or requiring irreversible
migration must use a separately reviewed protocol/data-format rollout; the current
verifier rejects other values. Candidates pause new turns until identity and local
readiness are committed. Preparation uses independent databases and never credential
reads. Startup must not introduce pre-commit live-data migration. The manifest
compatibility declaration is a publisher responsibility, not an automatic proof
that arbitrary future source changes preserve storage compatibility.

`test:sea` builds a small real executable and tests external JS and relocated Workers
with no Node in PATH. `test:sea:native` is an opt-in, heavier POSIX acceptance command:
it stages the real built CLI, uses an isolated local artifact
server/data directory, installs with empty PATH, probes native bindings/Workers,
updates, and injects a clean failed candidate to exercise rollback. It retains its
fixture directory and reports sizes. These checks do not establish production
signing/notarization, Windows Jobs, encrypted lifecycle authority, a full synthetic
Agent turn, or crash/disk-full acceptance across every supported platform.

No automatic cache GC runs: retain binaries, payloads, Node images and operation
records until a separate deletion protocol proves they have no readers. Initial
transfer includes both SEA and ordinary Node; later transfers reuse byte-identical
Node. Compressed payload size alone is not total installed disk usage.

## Recovering blocked ownership locally

A `blocked` result intentionally retains the Host lease: `daemon stop` cannot
assert that unknown descendants have exited, and reinstalling alone does not
clear the journal. Do not delete records while any old process might still write.
For this initial rollout, uncertain ownership requires OS-level recovery:

1. Disable the identified daemon's autostart registration and close other Lody
   hosts. Reboot the machine so the OS has ended every previous descendant; keep
   those hosts stopped after reboot.
2. In the printed `daemon-managed` directory, rename `operation.json` to a recovery
   archive and, if present, rename `selected.json` to a separate archive. Retain
   `operations/` unchanged: it fences replay of the original request IDs. Keep all
   user databases, credentials and release files untouched.
3. Install a trusted, known-good, data-compatible SEA with `daemon install`. With
   no active selection, its embedded release becomes the explicit recovery target.
   Re-enable only its fixed service entry, start it and check local readiness.

Archiving a selection without first proving the old writers gone is unsafe.
Automatic recovery across an uncertain root crash is not claimed by these steps.
