const HANDOFF_ATTR = 'data-lody-onboarding-handoff';
const HANDOFF_STYLE_ID = 'lody-onboarding-handoff-style';

const HANDOFF_CSS = `
@media (prefers-reduced-motion: no-preference) {
  html[${HANDOFF_ATTR}] [data-lody-composer-box] {
    view-transition-name: lody-primary-composer;
  }
  html[${HANDOFF_ATTR}]::view-transition-old(root) {
    animation: 160ms cubic-bezier(0.4, 0, 1, 1) both lody-onboarding-root-out;
  }
  html[${HANDOFF_ATTR}]::view-transition-new(root) {
    animation: 260ms cubic-bezier(0.2, 0, 0, 1) 60ms both lody-onboarding-root-in;
  }
  html[${HANDOFF_ATTR}]::view-transition-group(lody-primary-composer) {
    animation-duration: 360ms;
    animation-timing-function: cubic-bezier(0.18, 0.89, 0.24, 1);
  }
  html[${HANDOFF_ATTR}]::view-transition-old(lody-primary-composer),
  html[${HANDOFF_ATTR}]::view-transition-new(lody-primary-composer) {
    animation-duration: 180ms;
  }
}
@keyframes lody-onboarding-root-out {
  from { opacity: 1; }
  to { opacity: 0; }
}
@keyframes lody-onboarding-root-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
`;

function ensureHandoffStyle(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(HANDOFF_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = HANDOFF_STYLE_ID;
  style.textContent = HANDOFF_CSS;
  document.head.appendChild(style);
}

type DocumentWithViewTransition = Document & {
  startViewTransition?: (callback: () => Promise<void> | void) => {
    finished: Promise<void>;
    ready: Promise<void>;
  };
};

/**
 * Wraps the `Start → App` route navigation in a Same-Document View Transition
 * when supported and `prefers-reduced-motion` is off, morphing `[data-lody-composer-box]`
 * directly from the Onboarding stage into the App's composer slot (§6.2).
 */
export async function runOnboardingToAppTransition(
  navigateFn: () => Promise<void>,
  reducedMotion: boolean
): Promise<void> {
  if (typeof document === 'undefined' || reducedMotion) {
    await navigateFn();
    return;
  }

  const doc = document as DocumentWithViewTransition;
  if (typeof doc.startViewTransition !== 'function') {
    await navigateFn();
    return;
  }

  ensureHandoffStyle();
  document.documentElement.setAttribute(HANDOFF_ATTR, '');

  try {
    let navError: unknown = null;
    const transition = doc.startViewTransition(async () => {
      try {
        await navigateFn();
      } catch (err) {
        navError = err;
        throw err;
      }
    });
    void transition.finished
      .catch(() => undefined)
      .finally(() => {
        document.documentElement.removeAttribute(HANDOFF_ATTR);
      });
    await transition.ready.catch(() => undefined);
    if (navError) throw navError;
  } catch (err) {
    document.documentElement.removeAttribute(HANDOFF_ATTR);
    throw err;
  }
}
