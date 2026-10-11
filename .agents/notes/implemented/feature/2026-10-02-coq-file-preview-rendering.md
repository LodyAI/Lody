# Coq files use explicit Shiki rendering in read-only previews

Status: implemented
Translation: current

[中文](2026-10-02-coq-file-preview-rendering.zh.md)

## Abstract

The extended language pack previously recognized Coq only for Markdown fences,
while `.v` files stayed plain text because the file viewer used Monaco and did
not distinguish Rocq from V or Verilog. The file-language map now assigns `.v`
and `.rocq` to Coq when the pack is enabled, and read-only file previews pass
`lang: 'coq'` explicitly to the Shiki-backed viewer. Editable provider files
keep Monaco and remain plain text for Coq and Lean because those grammars have
no Monaco basic-language contribution.

## Decision

- Treat `.v` as Coq whenever the extended language pack is enabled; do not
  retain a Vlang or Verilog candidate in this client path.
- Gate `.v`, `.rocq`, `.coq`, and `.lean` file-language recognition with the
  existing local extended-language preference.
- Use the Shiki-backed read-only file viewer for Coq and Lean. Pass the language
  explicitly so filename inference cannot select Verilog for `.v`.
- Keep the `.v` file icon language-neutral instead of showing a Vlang-specific
  icon, since this client assigns the extension to Coq.
- Keep editable provider files on the existing Monaco surface. Monaco receives
  `plaintext` for languages without a registered contribution, preserving text
  editing without claiming unsupported syntax support.
- Apply the same Shiki viewer to the mobile file browser and honor the shared
  word-wrap and VS Code theme settings.

## Evidence and limits

The mapping lives in [session-file-language.ts](../../../../packages/components/src/lib/session-file-language.ts),
and the viewer is [session-shiki-text-viewer.tsx](../../../../packages/components/src/components/sessions/session-shiki-text-viewer.tsx).
The desktop session surface and mobile project browser select that viewer only
for read-only Coq or Lean text. Paged large-file previews remain bounded plain
text surfaces, and Coq language services or editing support are outside this
decision.

The earlier language-pack implementation recorded the `.v` ambiguity as out of
scope; that historical note remains unchanged for its original decision. This
follow-up records the later explicit mapping requested for the current client.

## Verification

- `session-file-language.test.ts` confirms that `.v` is plaintext with the pack
  off, resolves to Coq for Shiki with the pack on, and is never classified as
  Vlang.
- The focused file-language Vitest suite passes.
- Components typecheck reaches the changed files without new errors; the full
  command remains blocked by missing isolated `acp-extension-core` and
  `acp-extension-dsh` modules plus existing unrelated implicit-`any` errors.
