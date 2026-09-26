// Pure-DOM fallback UI used when the React tree cannot mount or has crashed
// during boot. Lives outside the React tree so it works even when no
// component or hook has had a chance to run.
//
// Design decisions:
// - No React: render via createElement/appendChild + addEventListener so the
//   page renders even if the React bundle never executes.
// - No external CSS and no StyleX: one scoped <style> element restating the
//   V2 tokens, so the page does not depend on Tailwind or StyleX having
//   loaded — a StyleX runtime error is itself one of the failures it shows.
// - Inline styles only (no inline scripts) keep us compatible with the
//   renderer CSP, which allows `style-src 'self' 'unsafe-inline'` but
//   blocks `script-src 'unsafe-inline'`.
// - Two affordances by design, words only: "Reload" first (so users can recover
//   in-page instead of force-quitting) and "Copy error" (so they can share
//   the raw error with us).

import { STATUS_ILLUSTRATION_CSS, STATUS_ILLUSTRATIONS } from './status-illustrations';

export type BootDiagnostics = {
  message: string;
  hint: string;
  details: string;
  copyableText: string;
};

// Normalized, low-cardinality classification of why boot failed (spec §7.4).
// Used as the `failure_kind` property on the pre-React `app/boot_failed` beacon.
export type BootFailureKind =
  | 'stale_asset'
  | 'legacy_browser'
  | 'offline'
  | 'module_load'
  | 'unknown';

/**
 * Which failure the page reports: the app never mounted (`boot`), or the main
 * process loaded the recovery page after the renderer died (`recovery`).
 */
export type BootFailureSurface = 'boot' | 'recovery';

export type BootFailureOptions = {
  /** Picks the page's title and first sentence. Defaults to `boot`. */
  surface?: BootFailureSurface;
  /** An extra sentence under the description, for what only the caller knows. */
  hint?: string;
  /**
   * Extra key/value pairs appended to the diagnostics block. Useful for build
   * commit, app version, runtime (electron/web), etc.
   */
  buildInfo?: Record<string, string>;
  /**
   * Normalized boot-failure classification for the `app/boot_failed` beacon.
   * Per-shell callers already compute the specific kind (stale asset / legacy
   * browser / offline); pass it here. When omitted we classify from the error.
   */
  failureKind?: BootFailureKind;
  /**
   * Platform tag for the beacon (web/electron/mobile). Defaults to 'web'.
   */
  platform?: string;
  /**
   * Override the Reload button behavior. Defaults to `window.location.reload()`.
   * Return a Promise to keep the button disabled while the reload is in flight.
   */
  onReload?: () => void | Promise<void>;
  /**
   * Optional hook that runs once the user clicks "Copy". Receives the full
   * copyable text. Use this to forward to telemetry/logging.
   */
  onCopy?: (text: string) => void;
};

function getMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name ? `${error.name}: ${error.message}` : error.message;
  }
  if (typeof error === 'string') return error;
  if (error == null) return 'Unknown error';
  if (typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const BOOT_BEACON_INSTALL_ID_KEY = 'lody_install_id';

// Classify a boot failure into a stable, low-cardinality kind for analytics.
// Message-pattern based because at boot time we only have the raw throw — but we
// never SEND the message, only the resulting enum (spec §2.3/§7.4).
export function classifyBootFailureKind(error: unknown): BootFailureKind {
  const message = (
    error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '')
  ).toLowerCase();
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'offline';
  }
  if (
    message.includes('mime type') ||
    message.includes('is not a valid javascript') ||
    message.includes('stale')
  ) {
    return 'stale_asset';
  }
  if (
    message.includes('invalid group specifier') ||
    message.includes('invalid regular expression') ||
    message.includes('invalid escape') ||
    (error instanceof SyntaxError && message.includes('unexpected token'))
  ) {
    return 'legacy_browser';
  }
  if (
    message.includes('failed to fetch dynamically imported module') ||
    message.includes('importing a module script failed') ||
    message.includes('error loading') ||
    message.includes('chunkloaderror') ||
    message.includes('failed to fetch')
  ) {
    return 'module_load';
  }
  return 'unknown';
}

function resolveBootBeaconInstallId(): string {
  if (typeof window === 'undefined') return 'anonymous';
  try {
    const existing = window.localStorage.getItem(BOOT_BEACON_INSTALL_ID_KEY);
    if (existing) return existing;
    const generated =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(BOOT_BEACON_INSTALL_ID_KEY, generated);
    return generated;
  } catch {
    return 'anonymous';
  }
}

function getBootBeaconConfig(): { key: string; host: string } | null {
  // import.meta.env is statically replaced by Vite at build time in every shell
  // that bundles this module, so reading it here works pre-React.
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const key = env.VITE_PUBLIC_POSTHOG_KEY;
  const host = env.VITE_PUBLIC_POSTHOG_HOST;
  if (!key || !host) return null;
  return { key, host: host.replace(/\/$/, '') };
}

// Low-level pre-React capture poster. The PostHog SDK is NOT mounted when boot
// fails, so we POST the capture payload directly via sendBeacon (survives the
// imminent reload/navigation) with a fetch keepalive fallback. Fire-and-forget;
// any failure is swallowed so it can never compound the boot failure (spec §7.4).
function postBootBeaconEvent(eventName: string, properties: Record<string, unknown>): void {
  try {
    const config = getBootBeaconConfig();
    if (!config) return;

    const payload = {
      api_key: config.key,
      event: eventName,
      distinct_id: resolveBootBeaconInstallId(),
      properties: {
        // $process_person_profile=false: these anonymous pre-auth beacons must
        // not create or mutate a person profile before the user is identified.
        $process_person_profile: false,
        client_ts_ms: Date.now(),
        ...properties,
      },
    };

    // PostHog's single-event capture endpoint (same one posthog-node/CLI use).
    const url = `${config.host}/capture/`;
    const body = JSON.stringify(payload);

    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function' &&
      typeof Blob !== 'undefined'
    ) {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(url, blob)) {
        return;
      }
    }

    if (typeof fetch === 'function') {
      void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
        mode: 'cors',
      }).catch(() => {
        // Swallow: a failed analytics beacon must not surface during boot.
      });
    }
  } catch {
    // Never let a boot beacon throw on top of an already-failed boot.
  }
}

// Pre-React `app/boot_failed` beacon (spec §7.4, tier A — full, never sampled).
export function captureBootFailedBeacon(error: unknown, options: BootFailureOptions = {}): void {
  const failureKind = options.failureKind ?? classifyBootFailureKind(error);
  postBootBeaconEvent('app/boot_failed', {
    failure_kind: failureKind,
    platform: options.platform ?? 'web',
    error_type: error instanceof Error ? error.name : typeof error,
    is_online: typeof navigator !== 'undefined' ? navigator.onLine : null,
    // install_id doubles as the distinct id; surface it as a prop too so it
    // joins with `app/launch.install_id` for the same install.
    install_id: resolveBootBeaconInstallId(),
  });
}

export function collectBootDiagnostics(
  error: unknown,
  options: BootFailureOptions = {}
): BootDiagnostics {
  const message = getMessage(error);

  const detailLines: string[] = [];
  if (typeof window !== 'undefined') {
    detailLines.push(`URL: ${window.location.href}`);
  }
  if (typeof navigator !== 'undefined') {
    detailLines.push(`User-Agent: ${navigator.userAgent}`);
    detailLines.push(`Online: ${navigator.onLine}`);
  }
  detailLines.push(`Time: ${new Date().toISOString()}`);

  if (options.buildInfo) {
    for (const [key, value] of Object.entries(options.buildInfo)) {
      detailLines.push(`${key}: ${value}`);
    }
  }

  if (error instanceof Error && error.stack) {
    detailLines.push('');
    detailLines.push('Stack:');
    detailLines.push(error.stack);
  }

  const details = detailLines.join('\n');
  const copyableText = `${message}\n\n${details}`;

  return {
    message,
    hint: options.hint ?? '',
    details,
    copyableText,
  };
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy fallback.
    }
  }

  if (typeof document === 'undefined') {
    return false;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  textarea.remove();
  return ok;
}

// ---------------------------------------------------------------------------
// The screen. It draws the column `components/status-page.tsx` draws, without
// React or StyleX: this page has to render when neither did (a StyleX runtime
// error is one of the boot failures it reports). So the V2 token values are
// restated here as custom properties on the page root — the literals in
// `@lody/ui/src/tokens/*.stylex.ts` — and a change to those tokens that should
// reach this page has to be copied here by hand.
// ---------------------------------------------------------------------------

const ROOT_CLASS = 'lody-boot-failure';
const THEME_STORAGE_KEY = 'vite-ui-theme';
const LANGUAGE_STORAGE_KEY = 'lody-language';
const COPIED_RESET_MS = 2000;

const LIGHT_VARS = `
  --bf-background: hsl(0 0% 100%);
  --bf-raised: hsl(0 0% 100%);
  --bf-label: hsl(225 7% 11%);
  --bf-secondary-label: hsl(220 9% 46%);
  --bf-tertiary-label: hsl(220 8% 62%);
  --bf-accent: hsl(220 82% 65%);
  --bf-destructive: hsl(356 72% 47%);
  --bf-region: color-mix(in oklab, transparent, hsl(225 7% 11%) 3%);
  --bf-hover: hsl(225 15% 94.9%);
  --bf-shadow-raised: 0 0 0 0.5px hsl(225 10% 11% / 0.16), 0 1px 1px hsl(225 10% 11% / 0.06), 0 2px 4px -1px hsl(225 10% 11% / 0.07);
  --bf-shadow-ink: inset 0 1px 0 hsl(0 0% 100% / 0.18), 0 1px 1.5px hsl(225 10% 11% / 0.18);
  --bf-sheen-raised: linear-gradient(hsl(225 10% 11% / 0), hsl(225 10% 11% / 0.03));
  --bf-sheen-ink: linear-gradient(hsl(0 0% 100% / 0.1), hsl(0 0% 100% / 0));
  --si-surface: hsl(0 0% 100%);
  --si-edge: hsl(225 7% 11% / 0.1);
  --si-shadow: hsl(225 10% 11% / 0.08);
  --si-region: hsl(220 23% 97.5%);
  --si-line: hsl(222 13% 85%);
  --si-dot: hsl(220 11% 78%);
  --si-accent: hsl(220 82% 65%);
  --si-on-accent: hsl(0 0% 100%);
  --si-ink: hsl(220 9% 70%);
  color-scheme: light;`;

const DARK_VARS = `
  --bf-background: hsl(0 0% 6.3%);
  --bf-raised: hsl(0 0% 13.7%);
  --bf-label: hsl(0 0% 100%);
  --bf-secondary-label: hsl(0 0% 62.7%);
  --bf-tertiary-label: hsl(0 0% 45%);
  --bf-accent: hsl(27 100% 80%);
  --bf-destructive: hsl(0 100% 75%);
  --bf-region: color-mix(in oklab, transparent, hsl(0 0% 100%) 3%);
  --bf-hover: hsl(0 0% 15.7%);
  --bf-shadow-raised: inset 0 1px 0 hsl(0 0% 100% / 0.08), 0 0 0 0.5px hsl(0 0% 0% / 0.7), 0 1px 2px hsl(0 0% 0% / 0.5);
  --bf-shadow-ink: inset 0 1px 0 hsl(0 0% 100% / 0.55), 0 1px 2px hsl(0 0% 0% / 0.5);
  --bf-sheen-raised: linear-gradient(hsl(0 0% 100% / 0.04), hsl(0 0% 100% / 0));
  --bf-sheen-ink: linear-gradient(hsl(0 0% 0% / 0), hsl(0 0% 0% / 0.08));
  --si-surface: hsl(0 0% 13.7%);
  --si-edge: hsl(0 0% 100% / 0.1);
  --si-shadow: hsl(0 0% 0% / 0.4);
  --si-region: hsl(0 0% 8.6%);
  --si-line: hsl(0 0% 22%);
  --si-dot: hsl(0 0% 27%);
  --si-accent: hsl(27 100% 80%);
  --si-on-accent: hsl(0 0% 0%);
  --si-ink: hsl(0 0% 34%);
  color-scheme: dark;`;

const R = `.${ROOT_CLASS}`;
const EASE = 'cubic-bezier(0.2, 0, 0, 1)';

// One stylesheet, scoped to the root class. The renderer CSP allows inline
// styles (`style-src 'unsafe-inline'`) but not inline scripts, so a <style>
// element is fine and every behaviour below is an addEventListener.
const STYLESHEET = `
${R} {${LIGHT_VARS}
  position: fixed; inset: 0; box-sizing: border-box; overflow-y: auto;
  display: flex; align-items: center; justify-content: center;
  padding: 32px 24px 12vh;
  background: var(--bf-background); color: var(--bf-label);
  font-family: var(--font-sans, 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif);
  -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) { ${R}:not([data-theme="light"]) {${DARK_VARS} } }
${R}[data-theme="dark"] {${DARK_VARS} }
${R} *, ${R} *::before, ${R} *::after { box-sizing: border-box; }
${R} .bf-drag { position: fixed; inset: 0 0 auto 0; height: 44px; -webkit-app-region: drag; }
${R} .bf-column {
  display: flex; flex-direction: column; align-items: center; gap: 16px; text-align: center;
  width: 100%; max-width: 440px; min-width: 0; margin-block: auto;
  -webkit-app-region: no-drag;
}
${R} .bf-header { display: flex; flex-direction: column; align-items: center; gap: 6px; }
${R} .bf-art { display: block; margin-bottom: 8px; line-height: 0; }
${R} h1 {
  margin: 0; font-size: 18px; line-height: 24px; font-weight: 600; letter-spacing: -0.01em;
  color: var(--bf-label); text-wrap: balance;
}
${R} .bf-description {
  margin: 0; font-size: 14px; line-height: 20px; color: var(--bf-secondary-label);
  overflow-wrap: anywhere; text-wrap: pretty;
}
${R} pre {
  align-self: stretch; text-align: start;
  margin: 0; min-width: 0; padding: 10px 12px; overflow: auto;
  border-radius: 10px; corner-shape: squircle; background: var(--bf-region);
  font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, 'SF Mono', 'SFMono-Regular', Menlo, Consolas, monospace);
  font-size: 12px; line-height: 18px; color: var(--bf-secondary-label);
  white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; -webkit-user-select: text;
}
${R} .bf-message { max-height: 144px; }
${R} .bf-details { max-height: 40vh; font-size: 11px; line-height: 16px; color: var(--bf-secondary-label); }
${R} .bf-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px; }
${R} .bf-button {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 28px; padding: 0 10px; margin: 0; border: 0; border-radius: 8px;
  font: inherit; font-size: 13px; font-weight: 500; letter-spacing: -0.01em; line-height: 1;
  white-space: nowrap; cursor: pointer; outline: none;
  transition: background-color 120ms ${EASE}, box-shadow 120ms ${EASE}, transform 120ms ${EASE}, opacity 120ms ${EASE};
}
${R} .bf-button:active { transform: translateY(1px); background-image: none; }
${R} .bf-button:disabled { opacity: 0.45; cursor: default; }
${R} .bf-button:focus-visible { box-shadow: 0 0 0 2px var(--bf-accent); }
${R} .bf-primary {
  background-color: var(--bf-label); background-image: var(--bf-sheen-ink);
  color: var(--bf-background); box-shadow: var(--bf-shadow-ink);
}
${R} .bf-primary:hover { background-color: color-mix(in oklab, var(--bf-label), var(--bf-background) 12%); }
${R} .bf-primary:active { box-shadow: none; }
${R} .bf-secondary {
  background-color: var(--bf-raised); background-image: var(--bf-sheen-raised);
  color: var(--bf-label); box-shadow: var(--bf-shadow-raised);
}
${R} .bf-secondary:hover { background-color: color-mix(in oklab, var(--bf-raised), var(--bf-label) 4%); }
${R} .bf-primary:focus-visible { box-shadow: var(--bf-shadow-ink), 0 0 0 2px var(--bf-accent); }
${R} .bf-secondary:focus-visible { box-shadow: var(--bf-shadow-raised), 0 0 0 2px var(--bf-accent); }
${R} .bf-status { margin: 0; font-size: 12px; line-height: 16px; color: var(--bf-secondary-label); text-wrap: pretty; }
${R} .bf-status:empty { display: none; }
${R} .bf-status[data-tone="danger"] { color: var(--bf-destructive); }
${R} .bf-disclosure {
  display: inline-flex; align-items: center; align-self: center; gap: 4px;
  margin: 0; padding: 0; border: 0; background: transparent; box-shadow: none; outline: none;
  font: inherit; font-size: 12px; line-height: 16px; color: var(--bf-secondary-label); cursor: pointer;
  transition: color 120ms ${EASE};
}
${R} .bf-disclosure:hover { color: var(--bf-label); }
${R} .bf-disclosure:focus-visible { color: var(--bf-label); text-decoration: underline; }
${R} .bf-disclosure svg { width: 14px; height: 14px; transition: transform 120ms ${EASE}; }
${R} .bf-disclosure[aria-expanded="true"] svg { transform: rotate(90deg); }
${R} .bf-footnote { margin: 0; font-size: 12px; line-height: 16px; color: var(--bf-tertiary-label); text-wrap: pretty; }
@media (prefers-reduced-motion: reduce) { ${R} * { transition: none !important; } }
${STATUS_ILLUSTRATION_CSS}
`;

// Lucide's chevron-right, inline: the icon package is part of the bundle that
// may not have run. The buttons carry words only; an icon beside "Reload" was
// decoration on a page meant to be calm.
const SVG_ATTRS =
  'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ICON_CHEVRON = `<svg ${SVG_ATTRS}><path d="m9 18 6-6-6-6"/></svg>`;

type BootFailureCopy = {
  title: string;
  loadFailedTitle: string;
  recoveryTitle: string;
  loadFailed: string;
  unknown: string;
  recovery: string;
  reload: string;
  reloading: string;
  copy: string;
  copied: string;
  copyFailed: string;
  diagnostics: string;
  build: string;
};

// i18next has not run either, so the page carries its own two languages.
const COPY: Record<'en' | 'zh_CN', BootFailureCopy> = {
  en: {
    title: "Lody didn't start this time",
    loadFailedTitle: "Part of Lody didn't load",
    recoveryTitle: 'The Lody window stopped',
    loadFailed: 'Your sessions and files are untouched — reloading usually fixes this.',
    unknown:
      "Your sessions and files are untouched. Reloading usually gets things going; if it doesn't, copy the error and send it to us.",
    recovery:
      'Your sessions and files are untouched. Reload to open it again; if it keeps happening, copy the error and send it to us.',
    reload: 'Reload',
    reloading: 'Reloading…',
    copy: 'Copy error',
    copied: 'Copied',
    copyFailed: 'Copying was blocked. Select the diagnostics below instead.',
    diagnostics: 'Diagnostics',
    build: 'Build',
  },
  zh_CN: {
    title: 'Lody 这次没能启动',
    loadFailedTitle: 'Lody 有一部分没加载出来',
    recoveryTitle: 'Lody 窗口停下来了',
    loadFailed: '你的会话和文件都没有受影响，通常重新加载就能恢复。',
    unknown: '你的会话和文件都没有受影响。通常重新加载就能恢复；如果不行，请复制错误发给我们。',
    recovery:
      '你的会话和文件都没有受影响。重新加载即可重新打开；如果反复出现，请复制错误发给我们。',
    reload: '重新加载',
    reloading: '正在重新加载…',
    copy: '复制错误',
    copied: '已复制',
    copyFailed: '复制被阻止了。请直接选择下方的诊断信息。',
    diagnostics: '诊断信息',
    build: '构建',
  },
};

function readStorage(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** The palette the person picked, when they picked one; otherwise the OS decides in CSS. */
function resolveForcedTheme(): 'light' | 'dark' | null {
  const stored = readStorage(THEME_STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : null;
}

/** The language setting (`atomWithStorage` stores it as JSON), else the OS locale. */
export function resolveBootFailureLanguage(): 'en' | 'zh_CN' {
  const stored = readStorage(LANGUAGE_STORAGE_KEY);
  if (stored) {
    try {
      const parsed: unknown = JSON.parse(stored);
      if (parsed === 'zh_CN' || parsed === 'en') return parsed;
    } catch {
      // Not JSON; fall through to the OS locale.
    }
  }
  const locale = typeof navigator === 'undefined' ? '' : (navigator.language ?? '');
  return locale.toLowerCase().startsWith('zh') ? 'zh_CN' : 'en';
}

function describeFailure(
  copy: BootFailureCopy,
  kind: BootFailureKind,
  surface: BootFailureSurface
): { title: string; description: string } {
  if (surface === 'recovery') return { title: copy.recoveryTitle, description: copy.recovery };
  // A chunk that did not load or a stale asset is the one case where the
  // cause and the likely fix are known, so the title names the cause — Lody
  // did start; part of it did not load — and the line under it names the fix.
  if (kind === 'module_load' || kind === 'stale_asset') {
    return { title: copy.loadFailedTitle, description: copy.loadFailed };
  }
  return { title: copy.title, description: copy.unknown };
}

function buildFootnote(
  copy: BootFailureCopy,
  buildInfo: Record<string, string> | undefined
): string {
  const build = buildInfo?.Build;
  if (!build || build === 'unknown') return '';
  const date = buildInfo?.BuildDate;
  return date && date !== 'unknown' ? `${copy.build} ${build} · ${date}` : `${copy.build} ${build}`;
}

export function renderBootFailure(
  rootElement: HTMLElement,
  error: unknown,
  options: BootFailureOptions = {}
): void {
  const diag = collectBootDiagnostics(error, options);
  const failureKind = options.failureKind ?? classifyBootFailureKind(error);

  // Pre-React `app/boot_failed` beacon (spec §7.4): emit once, here at the single
  // entry point every shell funnels boot failures through, before the SDK exists.
  captureBootFailedBeacon(error, { ...options, failureKind });

  // Make sure the error reaches the devtools console even when no UI is visible.
  // Use %s formatting so devtools renders multi-line strings nicely.
  console.error('[Lody] Boot failed.\n\nError: %s\n\nDiagnostics:\n%s', diag.message, diag.details);

  // React may have committed a partial tree before crashing; wipe it so the
  // fallback UI is the only thing visible.
  rootElement.innerHTML = '';

  const language = resolveBootFailureLanguage();
  const copy = COPY[language];
  const { title, description } = describeFailure(copy, failureKind, options.surface ?? 'boot');
  const footnote = buildFootnote(copy, options.buildInfo);

  const page = document.createElement('div');
  page.className = ROOT_CLASS;
  page.setAttribute('lang', language === 'zh_CN' ? 'zh-CN' : 'en');
  const forcedTheme = resolveForcedTheme();
  if (forcedTheme) page.dataset.theme = forcedTheme;

  const style = document.createElement('style');
  style.textContent = STYLESHEET;

  page.innerHTML =
    `<div class="bf-drag" aria-hidden="true"></div>` +
    `<div class="bf-column" role="alert">` +
    `<div class="bf-header"><span class="bf-art">${STATUS_ILLUSTRATIONS.broken}</span>` +
    `<h1>${escapeHtml(title)}</h1>` +
    `<p class="bf-description">${escapeHtml(description)}</p>` +
    (diag.hint ? `<p class="bf-description">${escapeHtml(diag.hint)}</p>` : '') +
    `</div>` +
    `<div class="bf-actions">` +
    `<button type="button" class="bf-button bf-primary" data-action="reload">${escapeHtml(copy.reload)}</button>` +
    `<button type="button" class="bf-button bf-secondary" data-action="copy">${escapeHtml(copy.copy)}</button>` +
    `</div>` +
    `<pre class="bf-message">${escapeHtml(diag.message)}</pre>` +
    `<p class="bf-status" data-role="status" aria-live="polite"></p>` +
    `<button type="button" class="bf-disclosure" data-action="diagnostics" aria-expanded="false" aria-controls="lody-boot-failure-diagnostics">${ICON_CHEVRON}<span>${escapeHtml(copy.diagnostics)}</span></button>` +
    `<pre class="bf-details" id="lody-boot-failure-diagnostics" hidden>${escapeHtml(diag.details)}</pre>` +
    (footnote ? `<p class="bf-footnote">${escapeHtml(footnote)}</p>` : '') +
    `</div>`;
  page.prepend(style);
  rootElement.appendChild(page);

  const copyButton = page.querySelector<HTMLButtonElement>('button[data-action="copy"]');
  const reloadButton = page.querySelector<HTMLButtonElement>('button[data-action="reload"]');
  const diagnosticsButton = page.querySelector<HTMLButtonElement>(
    'button[data-action="diagnostics"]'
  );
  const diagnosticsBlock = page.querySelector<HTMLPreElement>('#lody-boot-failure-diagnostics');
  const status = page.querySelector<HTMLParagraphElement>('[data-role="status"]');

  const setStatus = (text: string, tone: 'neutral' | 'danger' = 'neutral') => {
    if (!status) return;
    status.textContent = text;
    status.dataset.tone = tone;
  };

  const setDiagnosticsOpen = (open: boolean) => {
    if (!diagnosticsButton || !diagnosticsBlock) return;
    diagnosticsButton.setAttribute('aria-expanded', String(open));
    diagnosticsBlock.hidden = !open;
  };

  diagnosticsButton?.addEventListener('click', () => {
    setDiagnosticsOpen(diagnosticsButton.getAttribute('aria-expanded') !== 'true');
  });

  const beaconPlatform = options.platform ?? 'web';

  if (copyButton) {
    let copiedTimer: number | undefined;
    const showCopyLabel = (copied: boolean) => {
      copyButton.textContent = copied ? copy.copied : copy.copy;
    };
    copyButton.addEventListener('click', () => {
      postBootBeaconEvent('app/boot_failure_copy_clicked', { platform: beaconPlatform });
      copyButton.disabled = true;
      void copyToClipboard(diag.copyableText).then((ok) => {
        copyButton.disabled = false;
        if (ok) {
          // The button says it, where the eye already is; nothing else moves.
          showCopyLabel(true);
          setStatus('');
          window.clearTimeout(copiedTimer);
          copiedTimer = window.setTimeout(() => showCopyLabel(false), COPIED_RESET_MS);
          options.onCopy?.(diag.copyableText);
        } else {
          // The text has to stay reachable: open it for selection by hand.
          setStatus(copy.copyFailed, 'danger');
          setDiagnosticsOpen(true);
        }
      });
    });
  }

  if (reloadButton) {
    reloadButton.addEventListener('click', () => {
      postBootBeaconEvent('app/boot_failure_reload_clicked', { platform: beaconPlatform });
      reloadButton.disabled = true;
      setStatus(copy.reloading);
      const reenable = (): void => {
        reloadButton.disabled = false;
      };
      try {
        const result = options.onReload ? options.onReload() : undefined;
        if (result && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>)
            .catch((reloadErr) => {
              console.error('[Lody] onReload threw, falling back to location.reload', reloadErr);
              if (typeof window !== 'undefined') window.location.reload();
            })
            .finally(reenable);
          return;
        }
        if (!options.onReload && typeof window !== 'undefined') {
          window.location.reload();
        }
      } catch (reloadErr) {
        console.error('[Lody] onReload threw, falling back to location.reload', reloadErr);
        if (typeof window !== 'undefined') window.location.reload();
      }
      // Re-enable on every sync path (success, no-op, threw-and-recovered).
      // Most callers navigate away, but if onReload returns sync without
      // navigating, the button must not stay stuck disabled.
      reenable();
    });
  }
}
