/* Registers the `@pierre/diffs` container custom element with its core CSS in
   an open shadow root. Import for its side effect before rendering `FileDiff`. */
import { DIFFS_TAG_NAME, wrapCoreCSS } from '@pierre/diffs';

let sharedSheet: CSSStyleSheet | undefined;

function getDiffsStyleSheet(): CSSStyleSheet | undefined {
  if (typeof CSSStyleSheet === 'undefined') {
    return undefined;
  }

  sharedSheet ??= new CSSStyleSheet();
  sharedSheet.replaceSync(wrapCoreCSS(''));
  return sharedSheet;
}

if (typeof HTMLElement !== 'undefined' && customElements.get(DIFFS_TAG_NAME) == null) {
  customElements.define(
    DIFFS_TAG_NAME,
    class LodySiteDiffsContainer extends HTMLElement {
      constructor() {
        super();
        if (this.shadowRoot !== null) {
          return;
        }

        const shadowRoot = this.attachShadow({ mode: 'open' });
        const sheet = getDiffsStyleSheet();
        if (sheet !== undefined) {
          shadowRoot.adoptedStyleSheets = [sheet];
          return;
        }

        const style = document.createElement('style');
        style.textContent = wrapCoreCSS('');
        shadowRoot.appendChild(style);
      }
    }
  );
}
