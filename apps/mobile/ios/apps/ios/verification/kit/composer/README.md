# Shared native composer

Run from the repository root; the runner leases a verification Simulator:

```sh
pnpm verify:native
```

Exercises the production UIKit input without cloud writes: empty input, duplicate
send suppression, rejected-draft restoration, accepted-draft clearing, multiline
height limiting, and uncertain-result locking.

`pnpm verify:native` also compiles the shared `.metal` source into a temporary `LodyKitShaders.bundle` for the native checks. Xcode’s Metal Toolchain is required (`xcodebuild -downloadComponent MetalToolchain` if missing). App builds compile and package the same source through the LodyKit Swift package resource bundle.
