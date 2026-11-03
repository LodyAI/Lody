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

function internInnerHtml(raw: string, fillParent: boolean): { __html: string } {
  const key = JSON.stringify([raw, fillParent]);
  const existing = innerHtmlByMarkup.get(key);
  if (existing) return existing;
  const markup = fillParent
    ? raw.replace(/<svg\b([^>]*)>/, (_, attributes: string) => {
        const style = /\sstyle=("|')([\s\S]*?)\1/.exec(attributes);
        const dimensions = 'width:100%;height:100%;';
        const filled = style
          ? attributes.replace(style[0], ` style=${style[1]}${dimensions}${style[2]}${style[1]}`)
          : `${attributes} style="${dimensions}"`;
        return `<svg${filled}>`;
      })
    : raw;
  const created = { __html: markup };
  innerHtmlByMarkup.set(key, created);
  return created;
}

export function InlineSvg({
  raw,
  className,
  fillParent = false,
}: {
  raw: string;
  className?: string;
  /** Fill the wrapper while preserving explicit styles authored in the SVG. */
  fillParent?: boolean;
}) {
  return (
    <span
      className={className}
      aria-hidden="true"
      dangerouslySetInnerHTML={internInnerHtml(raw, fillParent)}
    />
  );
}
