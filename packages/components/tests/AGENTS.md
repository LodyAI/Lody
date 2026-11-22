# Shared component tests

Parent component and repository rules apply. Keep concrete product assumptions and
build/release guarantees; mixed suites keep only their qualifying cases.

- `setup.ts` supplies missing browser APIs for Node-only tests. In jsdom tests
  exercising storage quotas, `Storage.prototype` spies or `StorageEvent`, bind the
  global storage objects to `window.localStorage` and `window.sessionStorage` and
  restore them after the test. Node's storage globals can otherwise shadow jsdom's
  stores, so a prototype spy never reaches the storage being used.
- Load cold runtime modules before timed behavioral assertions or fake timers.
  Await explicit completion signals; compilation time is not a product deadline.
- Keep native export logic real and mock only platform I/O. When a lazy module's
  imports bypass those mocks, register that module with `vi.mock` forwarding to
  `importOriginal`; do not replace its product logic with a test implementation.

- `vitest.config.ts` automatically groups files without module mocks into shared
  Node/jsdom workers. Keep module mocks visible in the test file; do not hide
  registry changes in a helper. Shared suites must release their React roots and
  async owners; `setup-shared.ts` restores storage, timers and global test doubles.
  Files with persistent listeners or irreversible state belong in the explicit
  isolation list. File-path filters and CI shards must retain the same coverage.

- Label-only translation fixtures use `test-i18n.tsx`: own an independent instance
  and wrap each renderer root in its provider. Do not replace the global i18next
  instance or mock the `react-i18next` module just to supply labels.

- Workspace Streams fixtures load replicas through the same Repo passed to
  `src/providers/workspace-streams-transport.ts:createWorkspaceStreamsTransport`.
  Its `createRepoStreamsPersistence` wiring checks replica ownership; the Repo
  transport's `retireOnStaleReplica` rejects unregistered Docs before the intended
  network scenario runs. Leave registered replica cleanup to `repo.destroy()`.
