import type { SessionFileProvider } from './session-file-provider';

// Code Collab Monaco models use this URI scheme so a single global
// `registerDefinitionProvider` / `registerReferenceProvider` can pick
// them out from other Monaco models in the page. The authority carries
// the fileId; the path carries the workspace path so Monaco can infer
// extension-specific language behavior for TSX/JSX while LSP lookup still
// keys only by fileId.
//
// This module is deliberately free of `monaco-editor` imports so the file
// viewer can build model URIs and own provider registrations without
// pulling the editor bundle into the eager graph. The URI helpers
// reproduce `monaco.Uri` (vscode-uri) `from`/`parse` serialization for
// the restricted scheme/authority/path shape used here; the Monaco side
// parses the string form with `monaco.Uri.parse` once the editor chunk
// has loaded.
export const CODE_COLLAB_MONACO_URI_SCHEME = 'code-collab';

// vscode-uri's explicit escape table: these characters get a fixed
// `%XX` escape instead of `encodeURIComponent` (which would leave
// `!'()*` literal).
const URI_ESCAPE_TABLE: Record<number, string> = {
  58: '%3A', // :
  47: '%2F', // /
  63: '%3F', // ?
  35: '%23', // #
  91: '%5B', // [
  93: '%5D', // ]
  64: '%40', // @
  33: '%21', // !
  36: '%24', // $
  38: '%26', // &
  39: '%27', // '
  40: '%28', // (
  41: '%29', // )
  42: '%2A', // *
  43: '%2B', // +
  44: '%2C', // ,
  59: '%3B', // ;
  61: '%3D', // =
  32: '%20', // space
};

// Percent-encodes URI components the way `monaco.Uri` (vscode-uri)
// `toString` does. For paths (`encodeURIComponentFast`) unreserved marks
// pass through, `/` is allowed, and everything else takes the fixed
// escape from `URI_ESCAPE_TABLE` or `encodeURIComponent`.
function encodeUriComponentFast(value: string, allowSlash: boolean): string {
  let result = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const isUnreserved =
      (code >= 0x61 && code <= 0x7a) || // a-z
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x30 && code <= 0x39) || // 0-9
      char === '-' ||
      char === '.' ||
      char === '_' ||
      char === '~';
    if (isUnreserved || (allowSlash && char === '/')) {
      result += char;
    } else {
      result += URI_ESCAPE_TABLE[code] ?? encodeURIComponent(char);
    }
  }
  return result;
}

// `monaco.Uri.toString` splits the lowercased authority into
// `userinfo@host:port` at the FIRST `@` (extra `@`s belong to userinfo)
// and the last `:` of the host portion (port separator). Each segment is
// encoded with `encodeURIComponentFast`, except the host keeps
// `:`/`[`/`]` literal (port / IPv6 syntax).
function encodeUriAuthority(authority: string): string {
  let rest = authority.toLowerCase();
  let userinfo = '';
  const atIndex = rest.indexOf('@');
  if (atIndex !== -1) {
    const user = rest.slice(0, atIndex);
    rest = rest.slice(atIndex + 1);
    const colonIndex = user.indexOf(':');
    userinfo =
      colonIndex === -1
        ? `${encodeUriComponentFast(user, false)}@`
        : `${encodeUriComponentFast(user.slice(0, colonIndex), false)}:${encodeUriComponentFast(user.slice(colonIndex + 1), false)}@`;
  }
  const colonIndex = rest.lastIndexOf(':');
  if (colonIndex === -1) {
    return userinfo + encodeUriComponentFastAuthorityHost(rest);
  }
  return (
    userinfo +
    encodeUriComponentFastAuthorityHost(rest.slice(0, colonIndex)) +
    rest.slice(colonIndex)
  );
}

// Host portion of the authority: `encodeURIComponentFast` with `:`, `[`
// and `]` kept literal.
function encodeUriComponentFastAuthorityHost(host: string): string {
  let result = '';
  for (const char of host) {
    result +=
      char === ':' || char === '[' || char === ']' ? char : encodeUriComponentFast(char, false);
  }
  return result;
}

/**
 * Builds the serialized `code-collab://<fileId>/<path>` model URI,
 * identical to `monaco.Uri.from({scheme, authority, path}).toString()`
 * (authority is lowercased like `Uri`'s host normalization). Returns a
 * string instead of `monaco.Uri` so callers do not need the editor
 * bundle; the Monaco viewer parses it with `monaco.Uri.parse`, whose
 * `uri.toString()` reproduces this same string for `getModel` reuse.
 */
export function buildCodeCollabMonacoUri(fileId: string, filePath?: string): string {
  const normalizedPath = filePath?.replace(/\\/g, '/').replace(/^\/+/, '');
  const path = normalizedPath && normalizedPath.length > 0 ? `/${normalizedPath}` : '/';
  // `Uri.toString` omits the `//` entirely when the authority is empty.
  const authority = fileId.length > 0 ? `//${encodeUriAuthority(fileId)}` : '';
  return `${CODE_COLLAB_MONACO_URI_SCHEME}:${authority}${encodeUriComponentFast(path, true)}`;
}

/**
 * Reads the fileId (URI authority) back out of a serialized Code Collab
 * model URI — the same value `uri.authority` yields after
 * `monaco.Uri.parse`, i.e. percent-decoded. Returns `undefined` for
 * other schemes or a missing authority.
 */
export function readFileIdFromCodeCollabMonacoUri(modelUri: string): string | undefined {
  const schemeSeparator = modelUri.indexOf('://');
  if (
    schemeSeparator === -1 ||
    modelUri.slice(0, schemeSeparator) !== CODE_COLLAB_MONACO_URI_SCHEME
  ) {
    return undefined;
  }
  const rest = modelUri.slice(schemeSeparator + 3);
  const pathStart = rest.indexOf('/');
  const authority = pathStart === -1 ? rest : rest.slice(0, pathStart);
  if (authority.length === 0) return undefined;
  try {
    return decodeURIComponent(authority);
  } catch {
    // Keep undecodable input verbatim, mirroring monaco's lenient
    // percent decoder.
    return authority;
  }
}

// Registry mapping fileId → stack of SessionFileProviders. Each
// `SessionFileContentView` mount pushes its provider; the unmount
// removes that specific entry. Two concurrent mounts (e.g. diff
// viewer + editor on the same file) are common, so single-slot
// storage would let either unmount delete the entry the other still
// depends on. The stack lets the most-recently-mounted viewer drive
// the language providers while every mount safely owns one entry's
// worth of lifecycle.
const providerRegistry = new Map<string, SessionFileProvider[]>();

export function registerCodeCollabMonacoModelProvider(
  fileId: string,
  provider: SessionFileProvider
): () => void {
  let stack = providerRegistry.get(fileId);
  if (!stack) {
    stack = [];
    providerRegistry.set(fileId, stack);
  }
  stack.push(provider);
  return () => {
    const current = providerRegistry.get(fileId);
    if (!current) return;
    // `lastIndexOf` so a re-mount that happens to reuse the same
    // provider instance still removes its own most-recent entry.
    const index = current.lastIndexOf(provider);
    if (index >= 0) {
      current.splice(index, 1);
    }
    if (current.length === 0) {
      providerRegistry.delete(fileId);
    }
  };
}

/** Latest mounted provider for the fileId carried by `modelUri`. */
export function findCodeCollabMonacoModelProvider(
  modelUri: string
): SessionFileProvider | undefined {
  const fileId = readFileIdFromCodeCollabMonacoUri(modelUri);
  if (!fileId) return undefined;
  const stack = providerRegistry.get(fileId);
  return stack && stack.length > 0 ? stack[stack.length - 1] : undefined;
}
