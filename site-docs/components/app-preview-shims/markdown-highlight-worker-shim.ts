// Preview shim for `@/lib/markdown-highlight-worker`.
// The real module starts a module worker whose Shiki grammars are code-split;
// the marketing build keeps Vite's default worker format and does not bundle it.
// Returning no worker makes the real markdown renderer highlight on the main
// thread — the genuine component, just without the off-thread tokenizer.
export function getMarkdownHighlightWorker(): null {
  return null;
}
