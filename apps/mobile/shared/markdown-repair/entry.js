// Single source for streaming-Markdown repair on iOS (JavaScriptCore) and Android (QuickJS).
// Each platform bundles this file with its own pinned `remend` (keep the versions equal) and
// calls `repairMarkdown(text)` only while a message streams; the original text stays the
// source of truth for persistence and copy. Options disable repairs the native renderers
// cannot display or that misfire on agent output.
import remend from 'remend';

globalThis.repairMarkdown = (text) =>
  remend(text, {
    linkMode: 'text-only',
    katex: false,
    inlineKatex: false,
    htmlTags: false,
    comparisonOperators: false,
    singleTilde: false,
    setextHeadings: false,
  });
