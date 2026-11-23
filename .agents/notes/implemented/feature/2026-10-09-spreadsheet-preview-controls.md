# Spreadsheet preview controls

Status: implemented
Translation: current

[中文](2026-10-09-spreadsheet-preview-controls.zh.md)

## Abstract

CSV, TSV, and XLSX now support column resizing and copying a cell or rectangular
selection without saving the file. Existing renderers, workers and virtualization
remain. A small XLSX copy adapter works around the installed engine's worker-mode
clipboard bug. Copies preserve displayed values and structure within explicit limits.

CSV/TSV owns preview widths and pointer/Shift/keyboard selection with edge scrolling;
its virtualizers remeasure after width/zoom changes. XLSX retains engine selection
and enables `allowResizeInReadOnly`, also permitting preview-only row resizing.
In react-xlsx 0.16.5, worker loading clears the workbook that `getClipboardData`
requires. The adapter uses public `getRowsBatchAsync`, preserving formatted/cached
formula values and merged-secondary blanks. Disabling workers or parsing twice was rejected.

Copies emit escaped HTML tables and quoted TSV, limited to 200,000 cells and 10 Mi
characters. XLSX full-row reads are batched and capped at one million cells.
Clipboard writes begin in the gesture with promised data; abort fencing prevents
replaced previews from publishing stale data. No action calls a file save.
See the [earlier viewer decision](2026-09-29-session-office-and-table-viewers.md)
and draft [file-link Spec](../../../../specs/local-file-link-actions.md).

Focused coverage extends existing clipboard and Office-viewer acceptance suites.
Local Electron resource-scheme behavior remains outside Storybook coverage.
