import type { PreviewTarget } from './preview';

export type BrowserEngineKind = 'public-web' | 'managed-preview';
export type BrowserTargetClass = 'public' | 'loopback' | 'private-lan' | 'prohibited';

export type BrowserAddress = {
  logicalUrl: string;
  engine: BrowserEngineKind;
  targetClass: Exclude<BrowserTargetClass, 'prohibited'>;
  target?: PreviewTarget;
};

export type BrowserAddressErrorCode =
  | 'empty_address'
  | 'invalid_address'
  | 'invalid_scheme'
  | 'credentials_not_allowed'
  | 'prohibited_target';

export class BrowserAddressError extends Error {
  constructor(
    readonly code: BrowserAddressErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'BrowserAddressError';
  }
}

const containsControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
};
const EXPLICIT_SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):\/\//i;
const HOST_WITH_PORT_PATTERN =
  /^(?:localhost|(?:[^/?#:.]+\.)+[^/?#:.]+|\d+(?:\.\d+){0,3}|\[[0-9a-f:.]+\]):\d+(?:[/?#]|$)/i;
const OTHER_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

const stripIpv6Brackets = (host: string): string => {
  const normalized = host.trim().toLowerCase().replace(/\.$/, '');
  return normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized;
};

type Ipv4Octets = [number, number, number, number];

const parseIpv4 = (host: string): Ipv4Octets | null => {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets as Ipv4Octets;
};

const parseIpv6 = (host: string): number[] | null => {
  if (!host.includes(':')) return null;
  const doubleColonIndex = host.indexOf('::');
  if (doubleColonIndex !== -1 && doubleColonIndex !== host.lastIndexOf('::')) return null;

  const parseSide = (value: string): number[] | null => {
    if (!value) return [];
    const parts = value.split(':');
    const parsed = parts.map((part) =>
      /^[0-9a-f]{1,4}$/i.test(part) ? Number.parseInt(part, 16) : -1
    );
    return parsed.some((part) => part < 0) ? null : parsed;
  };

  if (doubleColonIndex === -1) {
    const parsed = parseSide(host);
    return parsed?.length === 8 ? parsed : null;
  }

  const left = parseSide(host.slice(0, doubleColonIndex));
  const right = parseSide(host.slice(doubleColonIndex + 2));
  if (!left || !right || left.length + right.length >= 8) return null;
  return [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right];
};

const classifyIpv4 = (octets: Ipv4Octets): BrowserTargetClass => {
  const [first, second, third, fourth] = octets;
  if (first === 127) return 'loopback';
  if (first === 10 || (first === 172 && second >= 16 && second <= 31)) return 'private-lan';
  if (first === 192 && second === 168) return 'private-lan';

  const prohibited =
    first === 0 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    (first === 255 && second === 255 && third === 255 && fourth === 255);
  return prohibited ? 'prohibited' : 'public';
};

const mappedIpv4 = (segments: number[]): Ipv4Octets | null => {
  if (!segments.slice(0, 5).every((segment) => segment === 0) || segments[5] !== 0xffff) {
    return null;
  }
  const high = segments[6] ?? 0;
  const low = segments[7] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
};

const classifyIpv6 = (segments: number[]): BrowserTargetClass => {
  if (segments.every((segment) => segment === 0)) return 'prohibited';
  if (segments.slice(0, 7).every((segment) => segment === 0) && segments[7] === 1) {
    return 'loopback';
  }
  const mapped = mappedIpv4(segments);
  if (mapped) return classifyIpv4(mapped);
  const first = segments[0] ?? 0;
  if ((first & 0xfe00) === 0xfc00) return 'private-lan';
  if ((first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return 'prohibited';
  return 'public';
};

export const classifyBrowserHostname = (hostname: string): BrowserTargetClass => {
  const host = stripIpv6Brackets(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  if (host === 'host.docker.internal' || host.endsWith('.local')) return 'private-lan';

  const ipv4 = parseIpv4(host);
  if (ipv4) return classifyIpv4(ipv4);
  const ipv6 = parseIpv6(host);
  if (ipv6) return classifyIpv6(ipv6);
  return 'public';
};

const parseWithDefaultScheme = (input: string): URL => {
  const explicitScheme = input.match(EXPLICIT_SCHEME_PATTERN)?.[1]?.toLowerCase();
  if (explicitScheme && explicitScheme !== 'http' && explicitScheme !== 'https') {
    throw new BrowserAddressError(
      'invalid_scheme',
      `Browser only supports HTTP(S) URLs, got ${explicitScheme}.`
    );
  }
  if (!explicitScheme && OTHER_SCHEME_PATTERN.test(input) && !HOST_WITH_PORT_PATTERN.test(input)) {
    throw new BrowserAddressError('invalid_scheme', 'Browser only supports HTTP(S) URLs.');
  }

  if (explicitScheme) return new URL(input);

  const provisional = new URL(`http://${input}`);
  const targetClass = classifyBrowserHostname(provisional.hostname);
  provisional.protocol = targetClass === 'public' ? 'https:' : 'http:';
  return provisional;
};

export const parseBrowserAddress = (rawInput: string): BrowserAddress => {
  if (containsControlCharacter(rawInput)) {
    throw new BrowserAddressError('invalid_address', 'The URL contains unsupported characters.');
  }
  const input = rawInput.trim();
  if (!input) {
    throw new BrowserAddressError('empty_address', 'Enter a URL.');
  }
  if (input.includes('\\') || input.startsWith('//')) {
    throw new BrowserAddressError('invalid_address', 'The URL contains unsupported characters.');
  }

  let url: URL;
  try {
    url = parseWithDefaultScheme(input);
  } catch (error) {
    if (error instanceof BrowserAddressError) throw error;
    throw new BrowserAddressError('invalid_address', 'Enter a valid HTTP(S) URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserAddressError('invalid_scheme', 'Browser only supports HTTP(S) URLs.');
  }
  if (url.username || url.password) {
    throw new BrowserAddressError(
      'credentials_not_allowed',
      'Credentials are not allowed in the Browser address bar.'
    );
  }

  const targetClass = classifyBrowserHostname(url.hostname);
  if (targetClass === 'prohibited') {
    throw new BrowserAddressError(
      'prohibited_target',
      'This address is reserved or unsafe and cannot be opened.'
    );
  }

  const logicalUrl = url.toString();
  // Two engines, split on exactly one question: is this the agent machine's own
  // loopback? Only that goes through Managed Preview, where the machine opens a
  // single approved port on itself. Everything else — public sites AND private
  // LAN / mDNS / docker hosts — is the user's own local browser reaching the
  // user's own network, which is the user's business. Routing a LAN address
  // through the machine would make that machine a pivot into its LAN; see
  // `apps/cli/src/preview/preview-service.ts` for the authoritative rejection.
  if (targetClass !== 'loopback') {
    return { logicalUrl, engine: 'public-web', targetClass };
  }

  const protocol = url.protocol === 'https:' ? 'https' : 'http';
  return {
    logicalUrl,
    engine: 'managed-preview',
    targetClass,
    target: {
      protocol,
      host: stripIpv6Brackets(url.hostname),
      port: url.port ? Number(url.port) : protocol === 'https' ? 443 : 80,
      path: `${url.pathname}${url.search}${url.hash}`,
    },
  };
};

export const formatPreviewTargetUrl = (target: PreviewTarget): string => {
  const host = target.host.includes(':') ? `[${stripIpv6Brackets(target.host)}]` : target.host;
  return new URL(target.path ?? '/', `${target.protocol}://${host}:${target.port}`).toString();
};
