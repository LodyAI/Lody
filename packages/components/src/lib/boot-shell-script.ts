/** Import-free startup decisions, also consumed by the document's inline script. */
export const BOOT_SHELL_SIDEBAR_WIDTH = { default: 280, min: 240, max: 420 } as const;

export const BOOT_SHELL_STORAGE_KEYS = {
  theme: 'vite-ui-theme',
  sidebarCollapsed: 'lody-sidebar-collapsed',
  sidebarWidth: 'lody-sidebar-last-width',
} as const;

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

export type BootShellLayout = 'plain' | 'workspace';

/** A destination hint describes geometry only; it grants no workspace access. */
export function resolveBootShellLayout(path: string): BootShellLayout {
  const segments = path.split(/[?#]/)[0]!.split('/');
  const segment = segments[1] ?? '';
  return segment &&
    !(BOOT_SHELL_NON_WORKSPACE_SEGMENTS as readonly string[]).includes(segment) &&
    segments[2] !== 'settings'
    ? 'workspace'
    : 'plain';
}

/** Runs before parsing the shell. Storage is read only; no last-route restoration. */
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
    "var g=p.split(/[?#]/)[0].split('/'),s=g[1]||'',v=!!s&&N.indexOf(s)<0&&g[2]!=='settings';" +
    "d.setAttribute('data-lody-boot-layout',v?'workspace':'plain');" +
    'var u=window.navigator.userAgent.toLowerCase(),m=!window.__LODY_ELECTRON__&&(/mobi|iphone|ipod|android|ipad|tablet|playbook|silk/.test(u)||window.navigator.userAgentData&&window.navigator.userAgentData.mobile===true)&&window.innerWidth<768;' +
    "d.setAttribute('data-lody-boot-mobile',m?'true':'false');" +
    `var x=j(L,K.sidebarWidth);x=typeof x==='number'&&x>0?Math.min(${max},Math.max(${min},x)):${defaultWidth};` +
    "d.style.setProperty('--lody-boot-sidebar-width',x+'px');" +
    "if(v&&!c&&window.innerWidth>=768)d.setAttribute('data-lody-boot-sidebar','');" +
    '}catch(e){}})()'
  );
}
