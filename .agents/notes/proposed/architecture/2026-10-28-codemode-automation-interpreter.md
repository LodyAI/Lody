# CodeMode as an automation condition interpreter

Status: proposed
Translation: current

[中文](2026-10-28-codemode-automation-interpreter.zh.md)

## Abstract

Lody currently evaluates persisted JavaScript conditions in a scoped QuickJS worker. OpenCode CodeMode could replace the interpreter, but the feature is unreleased, so its JavaScript subset need not preserve compatibility with prior development scripts. Lifecycle and resource behavior still require verification before removal. The local implementation uses CodeMode directly; full build and packaging verification remain outstanding. The existing [automation coordinator](2026-10-25-session-automation-coordinator.md) owns the condition and execution contracts.

## Evidence and proposal

- QuickJS receives a function expression and a scoped `ctx.read`; the worker client owns the 30-second timeout, 32-read budget, four concurrent reads, termination and joined owner reads. The interpreter also bounds QuickJS memory, stack and instruction fuel, validates result data and rejects outstanding reads. Conditions are persisted across restarts; the feature has not been released.
- The published `@opencode/codemode` 2.2.0 exposes Effect-native tools and a restricted JavaScript interpreter. A temporary independent probe adapted `ctx.read` to a tool and successfully ran a simple condition and the README CI example's `flatMap`/`filter` pattern. An infinite loop returned `TimeoutExceeded`. A directly wrapped function file with a trailing semicolon failed parsing, and an unawaited immediate read produced a successful result. These are narrow probes, not compatibility or security certification.
- The published package depends on Effect 4.0.1; Lody's catalog pins 4.0.2. A temporary probe using two Effect versions returned undefined tool results; forcing both to Lody’s 4.0.2 restored the simple and CI probes. The workspace override pins the CodeMode dependency to 4.0.2; The CLI now depends on CodeMode 2.2.0; its exact release is exempted from the seven-day minimum age at user request. An isolated pnpm installation confirmed both resolve to 4.0.2. Verify module identity, types, interruption and packaging without changing Lody’s locked version. CodeMode exposes timeout, tool-call and output limits, but no equivalent public instruction, stack or memory budget; the output limit does not bound interpreter heap. Choose the execution boundary based on tested cancellation and resource behavior; QuickJS and its WASM isolation need not be retained.
- Adopt the CodeMode language and update its callers and examples together; no compatibility adapter or language version is required for unreleased scripts. Preserve scoped authorization, result validation, read limits and cancellation. Verify registration validation, adversarial inputs, interruption, resource behavior and packaging.

The local implementation removes QuickJS and invokes CodeMode in the existing Effect scope. Tests cover conditions, MCP examples, scoped reads and cancellation; full workspace typechecking and desktop packaging remain unverified in this checkout.
