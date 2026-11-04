/** Collect owned bytes inside the caller's existing raw transport lease. Overflow
 * still awaits cancellation, and cancellation failure still releases the reader. */
export async function readBoundedBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<Uint8Array | undefined> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let complete = false,
    size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) {
        complete = true;
        break;
      }
      size += part.value.byteLength;
      if (size > maxBytes) return undefined;
      chunks.push(new Uint8Array(part.value));
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    try {
      if (!complete) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
