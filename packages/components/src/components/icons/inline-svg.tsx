/**
 * Registry SVG markup rendered inline.
 *
 * React 19's `updateProperties` compares `dangerouslySetInnerHTML` by object
 * identity, and `setProp` then assigns `innerHTML` unconditionally — unlike
 * React 18 it no longer compares the markup itself. A fresh `{ __html }`
 * literal per render therefore reparses the same SVG on every re-render of the
 * host. Interning the wrapper per markup string keeps the prop identity stable
 * so an unchanged icon is never reparsed. Keys come from
 * `REGISTRY_AGENT_ICON_SVGS`, so the table is bounded by the icon registry.
 */
const innerHtmlByMarkup = new Map<string, { __html: string }>();

function internInnerHtml(raw: string): { __html: string } {
  const existing = innerHtmlByMarkup.get(raw);
  if (existing) return existing;
  const created = { __html: raw };
  innerHtmlByMarkup.set(raw, created);
  return created;
}

export function InlineSvg({ raw, className }: { raw: string; className?: string }) {
  return (
    <span className={className} aria-hidden="true" dangerouslySetInnerHTML={internInnerHtml(raw)} />
  );
}
