# Capture renderer stalls before asking the user

Status: implemented
Translation: current

[中文](2026-09-20-renderer-hang-diagnostics.zh.md)

## Abstract

A renderer that recovered while its native warning was open could keep showing
warnings: Wait unconditionally restarted a timer, without tracking recovery.
The watchdog now owns a distinct active stall and gates both timers and dialog
results on its lifecycle. Main captures local JavaScript stacks and macOS native
samples at first detection, so investigations can identify executing code instead
of interpreting a repeated warning as proof of continuous blocking. Collection is
bounded and best effort; the original historical stall cannot be reconstructed.

## Decision and limits

A pure watchdog owns one dialog per window and invalidates stalls on recovery,
navigation and disposal. It replaces the old unresponsive timer in recovery state.
The [existing crash recovery decision](2026-09-16-renderer-crash-manual-recovery.md)
remains intact: diagnostic capture never reloads a renderer automatically.

Electron 39 `collectJavaScriptCallStack` can interrupt running JavaScript, unlike a
renderer-side logging callback. It requires an early Chromium feature switch and
a Document-Policy response header, including for file-scheme product documents.
A single session hook opts in only trusted product main frames. No debugger is
attached and no exception/stack telemetry is added. An unresolved API request is
not repeatedly reissued; native sampling supplies complementary evidence.

`renderer-hang.jsonl` serializes writes and rotates by UTF-8 byte count; concurrent
stack and recovery events cannot overwrite one another. Event identity, PID,
window state, CPU/memory and user choices distinguish a true continuing stall from
an already recovered window. CPU is a process measurement, not a diagnosis.
Native samples have count, byte, concurrency, duration and frequency limits.
Queries are omitted from the recorded route; stack files remain local diagnostics.

## Verification

Deterministic tests cover recovery during the dialog, repeated genuine stalls,
replacement stalls, navigation, close, explicit actions, stack timeout and
concurrent log rotation. Electron's package suite passes 162 tests. A separate
hidden Electron 39 probe using the production diagnostics captures a synthetic
busy-loop function with file/line and a macOS native thread sample. This is not
an installed production-app reproduction; minified names may need source maps.
