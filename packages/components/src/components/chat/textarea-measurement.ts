/** Measure content without shrinking the live composer and clamping its sibling scroller. */
export function measureTextareaScrollHeight(
  textarea: HTMLTextAreaElement,
  computed: CSSStyleDeclaration
): number {
  const mirror = textarea.ownerDocument.createElement('textarea');
  mirror.setAttribute('aria-hidden', 'true');
  mirror.tabIndex = -1;
  mirror.wrap = textarea.wrap;
  mirror.value = textarea.value;
  // Copy resolved text and box metrics: the mirror does not inherit the
  // composer's container styles, and a theme/font setting can change them.
  for (const property of [
    'box-sizing',
    'width',
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'font-stretch',
    'line-height',
    'letter-spacing',
    'word-spacing',
    'text-indent',
    'text-transform',
    'text-align',
    'tab-size',
    'direction',
    'white-space',
    'word-break',
    'overflow-wrap',
    'padding-top',
    'padding-bottom',
    'padding-left',
    'padding-right',
    'border-top-width',
    'border-bottom-width',
    'border-left-width',
    'border-right-width',
    'border-style',
  ]) {
    mirror.style.setProperty(property, computed.getPropertyValue(property));
  }
  Object.assign(mirror.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    visibility: 'hidden',
    pointerEvents: 'none',
    height: '0',
    minHeight: '0',
    maxHeight: 'none',
    overflow: 'hidden',
    margin: '0',
  });
  textarea.ownerDocument.body.appendChild(mirror);
  try {
    return mirror.scrollHeight;
  } finally {
    mirror.remove();
  }
}
