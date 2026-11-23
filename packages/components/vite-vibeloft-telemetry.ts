import type { HtmlTagDescriptor, Plugin } from 'vite';

export const VIBELOFT_STARTUP_DELAY_MS = 30_000;
export const VIBELOFT_IDLE_TIMEOUT_MS = 15_000;

const VIBELOFT_PRODUCT_ID = '791c7291-4457-4767-93e2-212a37340f20';
const VIBELOFT_SCRIPT_SRC = 'https://vibeloft.ai/telemetry/v1.js';

const VIBELOFT_LOADER_SOURCE = `(() => {
  const loader = document.currentScript;
  let scheduled = false;
  const load = () => {
    if (document.querySelector('script[data-lody-vibeloft-telemetry="true"]')) return;
    const script = document.createElement('script');
    script.async = true;
    script.src = ${JSON.stringify(VIBELOFT_SCRIPT_SRC)};
    script.dataset.lodyVibeloftTelemetry = 'true';
    script.dataset.vlProductId = loader?.dataset.vlProductId ?? '';
    script.dataset.vlAuthKey = loader?.dataset.vlAuthKey ?? '';
    document.head.appendChild(script);
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    window.setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(load, { timeout: ${VIBELOFT_IDLE_TIMEOUT_MS} });
      } else {
        load();
      }
    }, ${VIBELOFT_STARTUP_DELAY_MS});
  };
  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule, { once: true });
})();`;

export function createVibeloftTelemetryTags(authKey: string): HtmlTagDescriptor[] {
  if (!authKey.trim()) {
    return [];
  }

  return [
    {
      tag: 'script',
      attrs: {
        'data-lody-vibeloft-loader': 'true',
        'data-vl-product-id': VIBELOFT_PRODUCT_ID,
        'data-vl-auth-key': authKey.trim(),
      },
      children: VIBELOFT_LOADER_SOURCE,
      injectTo: 'head',
    },
  ];
}

export function vibeloftTelemetryPlugin(): Plugin {
  let authKey = '';

  return {
    name: 'vibeloft-telemetry',
    configResolved(config) {
      authKey = config.env.VITE_VIBELOFT_WEB_AUTH_KEY?.trim() ?? '';
    },
    transformIndexHtml() {
      return createVibeloftTelemetryTags(authKey);
    },
  };
}
