import { z } from 'zod';

const requestSchema = z
  .object({
    url: z.string().max(8192),
    options: z
      .object({
        method: z.enum(['GET', 'HEAD']).optional(),
        headers: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const MAX_BODY_BYTES = 64 * 1024;

/** Fetch an unauthenticated observation with a bounded decoded body. */
export async function fetchAutomationContext(input: unknown, signal: AbortSignal) {
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 128 * 1024)
    throw new Error('AUTOMATION_TOOL_INPUT_TOO_LARGE');
  const { url: address, options } = requestSchema.parse(input);
  const url = new URL(address);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('AUTOMATION_FETCH_INVALID_URL');
  const headers = new Headers(options?.headers);
  for (const name of headers.keys()) {
    if (!['accept', 'accept-language'].includes(name))
      throw new Error('AUTOMATION_FETCH_HEADER_NOT_ALLOWED');
  }
  const response = await fetch(url, {
    method: options?.method ?? 'GET',
    headers,
    redirect: 'error',
    signal,
  });
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BODY_BYTES) throw new Error('AUTOMATION_FETCH_BODY_TOO_LARGE');
        chunks.push(chunk.value);
      }
    }
  } catch (error) {
    await reader?.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader?.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    headers: Object.fromEntries(
      [...response.headers.entries()].filter(([name]) =>
        ['content-type', 'content-length', 'cache-control', 'etag', 'last-modified'].includes(name)
      )
    ),
    body: new TextDecoder().decode(bytes),
  };
}
