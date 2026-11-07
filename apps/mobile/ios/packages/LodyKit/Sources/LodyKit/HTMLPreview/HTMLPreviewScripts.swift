enum HTMLPreviewScripts {
  static let observer = #"""
  (() => {
    const report = (reference, kind, code = '') => {
      if (typeof reference !== 'string' || !reference) return;
      window.webkit.messageHandlers.lodyPreview.postMessage({reference: reference.slice(0, 2048), kind, code});
    };
    const localCode = (reference) => {
      try {
        const url = new URL(reference, document.baseURI);
        if (url.protocol === 'file:') return 'local_file_unavailable';
        if (/^(localhost|.*\.localhost|127\..*|\[::1\])$/i.test(url.hostname)) return 'local_service_unavailable';
      } catch {}
      return '';
    };
    window.addEventListener('error', (event) => {
      const target = event.target;
      if (target && target !== window && target.getAttribute) {
        const reference = target.getAttribute('src') || target.getAttribute('href') || '';
        report(reference, target.tagName.toLowerCase(), localCode(reference));
      } else if (event.filename) {
        report(event.filename, 'script', 'script_error');
      }
    }, true);
    window.addEventListener('unhandledrejection', () => report(document.baseURI, 'script', 'script_error'));
    const fetch = window.fetch;
    window.fetch = async function(input, ...args) {
      const reference = typeof input === 'string' ? input : input.url || String(input);
      const code = localCode(reference);
      if (code) { report(reference, 'fetch', code); throw new TypeError('Resource is unavailable in this preview'); }
      try {
        const response = await fetch.call(this, input, ...args);
        if (!response.ok) report(reference, 'fetch', 'resource_failed');
        return response;
      } catch (error) { report(reference, 'fetch'); throw error; }
    };
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, reference, ...args) {
      this.addEventListener('error', () => report(String(reference), 'xhr', localCode(String(reference))), {once: true});
      this.addEventListener('load', () => { if (this.status >= 400) report(String(reference), 'xhr'); }, {once: true});
      return open.call(this, method, reference, ...args);
    };
    // CSS image failures do not dispatch element error events.
    const scan = () => {
      for (const element of Array.from(document.querySelectorAll('*')).slice(0, 2048)) {
        if (element.tagName === 'A') continue;
        const reference = element.getAttribute('src') || element.getAttribute('href');
        if (reference && localCode(reference)) report(reference, element.tagName.toLowerCase(), localCode(reference));
        const background = getComputedStyle(element).backgroundImage;
        for (const match of background.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
          const code = localCode(match[1]);
          if (code) report(match[1], 'image', code);
        }
      }
    };
    window.addEventListener('load', scan);
    let scheduled = false;
    new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; scan(); });
    }).observe(document, {subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href', 'style', 'class']});
  })();
  """#
}
