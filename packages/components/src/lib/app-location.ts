type AppWindowLocation = {
  pathname: string;
  search: string;
};

const FALLBACK_ORIGIN = 'http://localhost';

function getConfiguredSiteOrigin(): string | null {
  const configuredSiteUrl = import.meta.env.VITE_SITE_URL?.trim();
  if (!configuredSiteUrl) {
    return null;
  }

  try {
    return new URL(configuredSiteUrl).origin;
  } catch {
    return null;
  }
}

function parseHashLocation(hash: string): AppWindowLocation | null {
  const normalizedHash = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!normalizedHash.startsWith('/')) {
    return null;
  }

  try {
    const url = new URL(normalizedHash, FALLBACK_ORIGIN);
    return {
      pathname: url.pathname,
      search: url.search,
    };
  } catch {
    return null;
  }
}

export function getAppWindowLocation(): AppWindowLocation {
  if (typeof window === 'undefined') {
    return {
      pathname: '/',
      search: '',
    };
  }

  if (window.location.protocol === 'file:') {
    const hashLocation = parseHashLocation(window.location.hash);
    if (hashLocation) {
      return hashLocation;
    }
  }

  return {
    pathname: window.location.pathname,
    search: window.location.search,
  };
}

export function getAppCurrentPathWithSearch(): string {
  const { pathname, search } = getAppWindowLocation();
  return `${pathname}${search}`;
}

export function getAppWindowSearchParams(): URLSearchParams {
  return new URLSearchParams(getAppWindowLocation().search);
}

export function getAppOriginForUrlParsing(): string {
  if (typeof window === 'undefined') {
    return FALLBACK_ORIGIN;
  }

  if (window.location.protocol === 'file:' || window.location.origin === 'null') {
    return FALLBACK_ORIGIN;
  }

  return window.location.origin;
}

export function getAppShareOrigin(): string {
  const configuredSiteOrigin = getConfiguredSiteOrigin();
  if (configuredSiteOrigin) {
    return configuredSiteOrigin;
  }

  return getAppOriginForUrlParsing();
}

export function getAppShareUrl(path = getAppCurrentPathWithSearch()): string {
  const normalizedPath = path.trim() ? `/${path.trim().replace(/^\/+/, '')}` : '/';
  return new URL(normalizedPath, `${getAppShareOrigin()}/`).toString();
}

export function replaceAppWindowLocation(path: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  if (window.location.protocol === 'file:') {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    window.location.replace(`${window.location.pathname}#${normalizedPath}`);
    return;
  }

  window.location.replace(path);
}
