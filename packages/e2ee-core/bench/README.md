# Manual E2EE measurements

Run from the repository after installing its pinned workspace dependencies:

```sh
pnpm --dir packages/e2ee-core exec node --import tsx bench/run.mts > bench.json
```

This is a manual developer tool, never an imported library module or CI gate.
It runs real signatures, native WebCrypto, SQLite, HPKE and isolated loopback HTTP.
It writes only temporary synthetic databases and removes them after native owners
close. JSON records Node/OpenSSL/CPU/platform, configuration and raw millisecond
samples. There are no performance thresholds and no timing assertions.

Defaults measure 1,000/10,000 signed records, 10/20/100 recipient devices and
64B/1KiB/64KiB/1MiB content, three samples each. Use `--iterations=1` for an initial
measurement, or `--quick` to verify the script with a smaller native workload.
Overrides: `--records=1000,10000 --devices=10,20,100 --content=64,1024`.

Interpret the individual measurements:

- `ledger.verify.pure/native`: current public full-prefix verifiers over identical
  authentic signed bytes. Generation is outside measured samples.
- `ledger.reopen.pure-audit`: native read-only SQLite SELECT plus pure public full
  verification; it is an audit benchmark, not another feed implementation.
- `ledger.reopen.native-feed`: the real scoped public feed open/current path.
- `ledger.snapshot-first.join`: verifies an independently pinned invitation
  snapshot and creates the real durable snapshot-origin feed without old records.
  It excludes invitation network acquisition and measures zero suffix records.
  Repeated ordinary role changes keep authorization-state size bounded, so this
  compares growing historical prefixes with the same-sized authenticated state.
- `content.seal/open`: the real Effect Streams binding, crypto and signature
  validation. Divide plaintext bytes by mean milliseconds for bytes/ms throughput.
- `epoch.prepare-envelopes`: actual poststate-bound signed HPKE frames; its JSON
  companion `epoch.stage-and-readback` records complete group byte size and native
  SQLite atomic persistence/readback. Candidate key/record preparation is outside
  these samples. This measures local staging, not Convex network/CPU limits.
- `key-round.cold/warm`: real public workspace owner/peer HTTP, installed stores,
  ciphertext delivery and reports. Cold includes initial delivery; warm measures
  a settled finite round. This uses the existing Lab fixture as an explicit
  development-only consumer, not a core runtime dependency or OS-keychain test.

Machine load, CPU scaling and caches affect measurements. Keep raw JSON and repeat
on a controlled host before drawing comparisons. A successful run means the
measurement completed; it is not a production-performance acceptance statement.
