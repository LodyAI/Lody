# Convert pasted text to a file at 50,000 characters

Status: implemented
Translation: current

[中文](2026-10-12-paste-file-character-threshold.zh.md)

## Abstract

The previous 500 KiB UTF-8 threshold kept large pasted text embedded in drafts and prompts. The requested threshold is now 50,000 characters, inclusive, measured after normalizing line endings and trimming surrounding whitespace. Both new and existing conversation composers share this decision and preserve raw clipboard text in `pasted-text.txt`. Smaller pastes keep the existing inline or folded behavior.

## Decision and verification

This replaces the size decision in the [oversized-paste attachment note](2026-09-28-oversized-paste-text-file.md). Counting reuses JavaScript string length: ordinary Chinese and ASCII count equally; supplementary Unicode characters occupy two UTF-16 code units. Attachment validation and sending retain existing paths.

Updated helper tests cover 49,999, 50,000 and 50,001 characters for ASCII and Chinese, plus whitespace and CRLF normalization. Updated rendered session tests check exact attachment content at 50,000 and folding at 49,999. Packaged clipboard behavior remains unverified.

Executed verification: all 23 helper-suite tests passed using an existing dependency environment. The rendered suite could not collect because that environment supplies Effect v3 while this checkout requires v4 (`Context.Service` is unavailable). Documentation checks report existing missing-submodule links; no changed document is implicated. Formatting and `git diff --check` passed.

PR: [#1511](https://github.com/LodyAI/Lody/pull/1511)
