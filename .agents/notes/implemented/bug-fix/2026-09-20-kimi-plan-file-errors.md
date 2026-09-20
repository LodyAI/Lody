# Preserve missing-file semantics across ACP

Status: implemented
Translation: current

[中文](2026-09-20-kimi-plan-file-errors.zh.md)

## Abstract

Kimi could enter Plan and then report a configuration failure because its plan
file did not exist yet. ACP file access lost the native missing-file semantics,
so subsequent Plan reads, including disabling Plan, also failed. Lody now maps
`ENOENT` to ACP resource-not-found, and Kimi's filesystem adapter maps that code
back to `ENOENT`. Other errors continue to propagate; the change does not alter
planning or permission policy.

## Cause and boundary

The [Plan consumer integration](2026-09-10-core-plan-mode-consumers.md) already
sent the correct boolean option. Kimi enters Plan before creating its file, then
reads Plan status to produce configuration snapshots. Its engine tolerates
native `ENOENT`, but Lody's raw file error became JSON-RPC `Internal error`.
Even a conforming client returning `-32002` failed because Kimi did not translate
that error for its engine. A failed response did not undo the entered Plan state.

`AgentClient.readTextFile` owns native-to-ACP conversion after session validation.
Kimi's `AcpHostFileSystem.readText` owns ACP-to-native conversion, including the
original error as the cause; append retains its missing-file creation behavior.
No provider-specific protocol logic enters the Kimi engine. Only structured
resource-not-found is normalized: arbitrary internal errors and messages
containing `ENOENT` are not treated as missing files. Precreating a plan file or
returning empty content for every failed read would hide the broken contract.

## Verification and delivery

An isolated synthetic client reproduced the failure against managed runtime
`2.0.0-lody.251770890d42`, without model requests. Local filesystem access passed;
ACP reads returning internal error or resource-not-found failed. Both regression
tests failed before their respective fixes. The CLI suite covers missing files,
line slicing, non-missing I/O failures and session mismatch. The Kimi suite covers
repeated enable/disable with and without ACP file access, preserving YOLO, plus
append and non-missing read failures.

Kimi is a separately built managed runtime. Source and gitlink changes alone do
not update installed runtimes: build and publish the fixed checksummed artifact
before advancing the runtime manifest. No production artifact is published by
this source fix. Whole-workspace verification limitations are recorded in the PR.

Lody PR: [#846](https://github.com/LodyAI/Lody/pull/846).
Kimi PR: [#12](https://github.com/LodyAI/acp-extension-kimi/pull/12).
