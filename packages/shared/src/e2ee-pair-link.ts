/** Longest accepted pairing link; anything longer is not a Lody pairing link. */
const MAX_LENGTH = 512;

/**
 * The link itself when it is a `lody://auto-pair?…` approval link, otherwise `null`. The OS
 * may hand over any letter case for the scheme and host. Join links (`lody://pair/…`), OAuth
 * callbacks and every other value are not approval links.
 */
export function parseAutoPairLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol.toLowerCase() === 'lody:' &&
    url.hostname.toLowerCase() === 'auto-pair' &&
    url.search.length > 1
    ? value
    : null;
}
