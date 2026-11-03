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
