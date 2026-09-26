/**
 * The boot shell's `<head>` script (see `boot-shell.ts`). It lives in its own
 * module with no imports so the desktop CSP test can load it directly under
 * Node and hash it.
 */

/** Mirrors `LoroSidebar`'s `defaultWidth` / `minWidth` / `maxWidth`. */
export const BOOT_SHELL_SIDEBAR_WIDTH = { default: 280, min: 240, max: 420 } as const;

/**
 * Storage keys the boot script reads. Each belongs to the atom or helper named
 * beside it; the script only reads them and never writes.
 */
export const BOOT_SHELL_STORAGE_KEYS = {
  /** `ThemeProvider` (next-themes `storageKey`): 'light' | 'dark' | 'system'. */
  theme: 'vite-ui-theme',
  /** `sidebarCollapsedAtom`, JSON boolean in the window's storage. */
  sidebarCollapsed: 'lody-sidebar-collapsed',
  /** `sidebarLastWidthAtom`, JSON number in localStorage; 0 means default. */
  sidebarWidth: 'lody-sidebar-last-width',
  /** `last-app-route.ts`, JSON `{ path }` in the window's storage. */
  lastAppRoute: 'lody:lastAppRoute',
} as const;

/**
 * Top-level route segments that are not workspace slugs. None of them render
 * the workspace sidebar, so the shell draws only the centred mark there.
 */
export const BOOT_SHELL_NON_WORKSPACE_SEGMENTS = [
  'app',
  'complete-email',
  'desktop',
  'device',
  'email-verified',
  'forgot-password',
  'invite',
  'join',
  'login',
  'onboarding',
  'reset-password',
  'workspace',
] as const;

/**
 * Runs synchronously in `<head>`, before the shell is parsed. It resolves the
 * same theme `ThemeProvider` will (stored choice, else the OS preference) and
 * whether the workspace sidebar will be visible, and records both on `<html>`.
 * Any storage failure leaves the defaults: light canvas, mark only.
 */
export function createBootShellScript(): string {
  const keys = JSON.stringify(BOOT_SHELL_STORAGE_KEYS);
  const nonWorkspace = JSON.stringify(BOOT_SHELL_NON_WORKSPACE_SEGMENTS);
  const { default: defaultWidth, min, max } = BOOT_SHELL_SIDEBAR_WIDTH;
  return (
    '(function(){var d=document.documentElement;' +
    "d.style.setProperty('--lody-boot-elapsed',Math.round(performance.now())+'ms');" +
    `try{var K=${keys},N=${nonWorkspace},L=localStorage,S=sessionStorage,h=location.href;` +
    'function j(s,k){try{return JSON.parse(s.getItem(k))}catch(e){return null}}' +
    "var t=L.getItem(K.theme),k=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light';" +
    'd.classList.add(k);d.style.colorScheme=k;' +
    "var a=/[?&]window=(session|workspace)(&|$)/.test(h)||S.getItem('lody:auxiliaryWindow')==='1',w=a?S:L;" +
    "var sw=/[?&]window=session(&|$)/.test(h)||w.getItem('lody:sessionWindow')==='1';" +
    'var c=j(w,K.sidebarCollapsed);if(typeof c!=="boolean")c=sw;' +
    "var p=location.hash.charAt(1)==='/'?location.hash.slice(1):location.pathname;" +
    "if(p==='/'||p===''){var r=j(w,K.lastAppRoute);p=r&&typeof r.path==='string'?r.path:''}" +
    "var g=p.split(/[?#]/)[0].split('/'),s=g[1]||'';" +
    "if(!c&&s&&N.indexOf(s)<0&&g[2]!=='settings'){" +
    `var x=j(L,K.sidebarWidth);x=typeof x==='number'&&x>0?Math.min(${max},Math.max(${min},x)):${defaultWidth};` +
    "d.setAttribute('data-lody-boot-sidebar','');d.style.setProperty('--lody-boot-sidebar-width',x+'px')}" +
    '}catch(e){}})()'
  );
}
