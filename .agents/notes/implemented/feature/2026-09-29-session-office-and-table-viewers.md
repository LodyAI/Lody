# Session Office and table viewers

Status: implemented
Translation: current

[中文](2026-09-29-session-office-and-table-viewers.zh.md)

## Abstract

Session files now preview modern DOCX, XLSX, and PPTX documents and CSV/TSV
tables. The Office viewers are read-only; CSV/TSV retains the existing editable
Source tab. This extends the [file action Spec](../../../../specs/local-file-link-actions.md)
without changing file identity, authorization, or OS actions.

## Decision

The common file-viewer entry remains static. An active Office preview schedules
a bounded read at idle and demand-imports only the selected format renderer and
its engine. No Office engine or worker loads for an inactive panel. The Office
read is capped at 25 MiB, while a remote provider's earlier binary transfer cap
still applies. DOCX requires worker parsing, XLSX uses its read-only virtual
grid, and PPTX uses virtual slide rendering. Unsupported legacy Office formats
continue to show the binary notice. All product-owned controls use StyleX; the
PPTX engine's own stylesheet remains engine-owned. That vendor stylesheet is
imported as raw text and attached only while the PPTX renderer is mounted: a
normal CSS import from this lazy chunk moves the app's extracted StyleX rules
out of the startup stylesheet, leaving unrelated desktop screens unstyled.

CSV/TSV parsing and searching use a disposable worker. The table caps rows,
columns, cells, and retained search matches, then virtualizes both grid axes.
The existing source editor is not replaced. Worker termination and abort guards
prevent a hidden or changed file from publishing stale content.

This is a narrow exception to the prior static-viewer rule: the file shell is
static, but large third-party Office engines are loaded only on demand. The
earlier [PDF controls note](2026-09-29-session-pdf-viewer-controls.md) owns the
PDF-specific design.

## Verification

- Storybook rendered synthetic DOCX, XLSX, PPTX, and CSV fixtures in a browser.
- Playwright acceptance covers rendering, controls, search, and inactive Office
  and CSV panels that fetch no engine or worker.
- The Electron build keeps extracted StyleX rules in its startup CSS asset while
  the PPTX vendor stylesheet stays in the lazy renderer chunk.
- Local Electron resource-scheme rendering remains unverified in this worktree.
