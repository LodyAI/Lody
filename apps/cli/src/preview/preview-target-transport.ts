import { isIP, type LookupFunction } from 'node:net';
import { Pool, fetch as undiciFetch, type RequestInit } from 'undici';
import { classifyBrowserHostname, type PreviewTarget } from '@lody/shared';

/** Direct, origin-bound transport. Host/TLS identity remains the approved target;
 * localhost connects only to the literal address selected by its HTTP probe. */
export function createPreviewTargetTransport(target: PreviewTarget, address = target.host) {
  const family = isIP(address);
  if (
    !family ||
    classifyBrowserHostname(address) !== 'loopback' ||
    (target.host !== 'localhost' && target.host !== address)
  ) {
    throw new Error('Preview transport requires the approved literal loopback address');
  }
  const lookup: LookupFunction = (hostname, options, callback) => {
    if (hostname !== 'localhost') {
      callback(new Error('Preview transport does not resolve external hostnames'), []);
      return;
    }
    callback(null, options.all ? [{ address, family }] : address, family);
  };
  const host = target.host.includes(':') ? `[${target.host}]` : target.host;
  const dispatcher = new Pool(`${target.protocol}://${host}:${target.port}`, {
    connect: { lookup },
  });
  return { dispatcher, lookup };
}

export async function fetchPreviewTarget(
  url: URL | string,
  options: RequestInit & { dispatcher: Pool }
): Promise<Response> {
  // Undici and DOM describe the same WHATWG response with different TS interfaces.
  return (await undiciFetch(url, options)) as unknown as Response;
}
