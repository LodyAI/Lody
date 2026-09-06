import { imageDimensionsFromData } from 'image-dimensions'
import { randomUUID, createHash } from 'node:crypto'
import { open, type FileHandle } from 'node:fs/promises'
import { constants, type Stats } from 'node:fs'
import { getImageMimeTypeForPath, isBinaryImagePath } from '@lody/shared/image-file-types'
import type { LocalFileResolution, LocalFilePreviewResource } from '@lody/shared/local-file-preview'
import { LOCAL_TEXT_EDIT_BYTES, LOCAL_TEXT_PAGE_BYTES } from '@lody/shared/local-file-preview'

const revision = (s: Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
type Resource = {
  owner: number
  path: string
  revision: string
  size: number
  mime: string
  text: boolean
  readers: Set<() => void>
  revoked: boolean
}

/** No retained file descriptors or whole-file buffers. Every read revalidates identity. */
export class LocalFileResources {
  private readonly resources = new Map<string, Resource>()

  releaseOwner(owner: number) {
    for (const [key, resource] of this.resources)
      if (resource.owner === owner) this.revoke(key, resource)
  }

  private revoke(key: string, resource: Resource) {
    resource.revoked = true
    for (const close of resource.readers) close()
    this.resources.delete(key)
  }

  async preview(owner: number, file: LocalFileResolution) {
    const handle = await open(
      file.absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error('Not a regular file.')
      const bytes = await readWindow(handle, 0, Math.min(stat.size, LOCAL_TEXT_EDIT_BYTES + 1))
      const mime = isBinaryImagePath(file.path) ? getImageMimeTypeForPath(file.path) : undefined
      if (mime) {
        const dimensions = imageDimensionsFromData(bytes) ?? legacyImageDimensions(bytes)
        if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
          return {
            status: 'error' as const,
            v: 3 as const,
            code: 'decode_error' as const,
            message: 'Image dimensions could not be read.',
            path: file.path
          }
        }
        // Decode cost is pixels, independent of encoded file size or IPC framing.
        if (
          dimensions.width * dimensions.height > 64 * 1024 * 1024 ||
          Math.max(dimensions.width, dimensions.height) > 32768
        ) {
          return {
            status: 'error' as const,
            v: 3 as const,
            code: 'too_large' as const,
            message:
              'Image dimensions exceed the preview memory budget. Open it in a system application.',
            path: file.path
          }
        }
      }
      let text: string | undefined
      if (!mime && !bytes.subarray(0, 8192).includes(0)) {
        try {
          text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, {
            stream: bytes.length < stat.size
          })
        } catch {
          /* binary */
        }
      }
      if (revision(await handle.stat()) !== revision(stat))
        throw new Error('File changed. Reopen the preview.')
      if (text !== undefined && stat.size <= LOCAL_TEXT_EDIT_BYTES) {
        return {
          status: 'ok' as const,
          v: 3 as const,
          path: file.path,
          external: file.external,
          digest:
            `sha256:${createHash('sha256').update(bytes).digest('hex')}` as `sha256:${string}`,
          kind: 'text' as const,
          sizeBytes: stat.size,
          readonly: true,
          content: { encoding: 'utf8-plain' as const, text, rawBytes: bytes.length },
          format: {
            bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
            eol: (text.includes('\r\n')
              ? text.replaceAll('\r\n', '').includes('\n')
                ? 'mixed'
                : 'crlf'
              : text.includes('\n')
                ? 'lf'
                : 'unknown') as 'mixed' | 'crlf' | 'lf' | 'unknown'
          }
        }
      }
      // Reopening the same revision reuses its capability; registrations are bounded per renderer.
      let token = [...this.resources].find(
        ([, r]) =>
          r.owner === owner && r.path === file.absolutePath && r.revision === revision(stat)
      )?.[0]
      if (!token) {
        const owned = [...this.resources].filter(([, r]) => r.owner === owner)
        if (owned.length >= 256) this.revoke(owned[0][0], owned[0][1])
        token = randomUUID()
        this.resources.set(token, {
          owner,
          path: file.absolutePath,
          revision: revision(stat),
          size: stat.size,
          text: text !== undefined,
          mime: mime ?? 'application/octet-stream',
          readers: new Set(),
          revoked: false
        })
      }
      return {
        status: 'resource',
        path: file.path,
        external: file.external,
        kind: text === undefined ? 'binary' : 'text',
        sizeBytes: stat.size,
        url: `lody-resource://file/${token}`
      } satisfies LocalFilePreviewResource
    } finally {
      await handle.close()
    }
  }

  async respond(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const resource = url.hostname === 'file' ? this.resources.get(url.pathname.slice(1)) : undefined
    if (!resource) return new Response(null, { status: 404 })
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(null, { status: 405 })
    let handle: FileHandle | undefined
    try {
      handle = await open(
        resource.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      )
      const stat = await handle.stat()
      if (!stat.isFile() || revision(stat) !== resource.revision) {
        await handle.close()
        return new Response('File changed. Reopen the preview.', { status: 409 })
      }
      const range = request.headers.get('Range')
      const match = range?.match(/^bytes=(\d+)-(\d*)$/u)
      let start = match ? Number(match[1]) : 0
      let end = match && match[2] ? Number(match[2]) : resource.size - 1
      if (
        (range && !match) ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start >= resource.size ||
        end < start
      ) {
        await handle.close()
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${resource.size}` }
        })
      }
      end = Math.min(end, resource.size - 1)
      // Text is exclusively range-read. Even a caller ignoring the UI cannot allocate it whole.
      if (resource.text && (!range || end - start + 1 > LOCAL_TEXT_PAGE_BYTES + 6)) {
        await handle.close()
        return new Response(null, { status: 416 })
      }
      const headers = {
        'Content-Type': resource.mime,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        // Opaque unguessable capability; never a filesystem path or a wildcard file handler.
        'Access-Control-Allow-Origin': '*',
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${resource.size}` } : {})
      }
      if (request.method === 'HEAD') {
        await handle.close()
        return new Response(null, { headers, status: range ? 206 : 200 })
      }
      const reader = handle
      let closed = false
      const close = async () => {
        if (!closed) {
          closed = true
          await reader.close()
        }
      }
      const abort = () => {
        void close().catch(() => {})
      }
      resource.readers.add(abort)
      request.signal.addEventListener('abort', abort, { once: true })
      const finish = async () => {
        resource.readers.delete(abort)
        request.signal.removeEventListener('abort', abort)
        await close()
      }
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (request.signal.aborted || resource.revoked) throw new Error('Preview cancelled.')
            if (revision(await reader.stat()) !== resource.revision)
              throw new Error('File changed. Reopen the preview.')
            const bytes = await readWindow(reader, start, Math.min(64 * 1024, end - start + 1))
            if (!bytes.length) throw new Error('File changed. Reopen the preview.')
            if (revision(await reader.stat()) !== resource.revision)
              throw new Error('File changed. Reopen the preview.')
            start += bytes.length
            controller.enqueue(bytes)
            if (start > end) {
              await finish()
              controller.close()
            }
          } catch (error) {
            await finish()
            controller.error(error)
          }
        },
        async cancel() {
          await finish()
        }
      })
      return new Response(stream, { status: range ? 206 : 200, headers })
    } catch (error) {
      await handle?.close().catch(() => {})
      return new Response(error instanceof Error ? error.message : 'Preview unavailable.', {
        status: 409
      })
    }
  }
}

async function readWindow(handle: FileHandle, position: number, length: number) {
  const bytes = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const result = await handle.read(bytes, offset, length - offset, position + offset)
    if (!result.bytesRead) break
    offset += result.bytesRead
  }
  return bytes.subarray(0, offset)
}

/** The dimension library intentionally omits BMP and ICO. Both have fixed headers. */
function legacyImageDimensions(bytes: Buffer) {
  if (bytes.length >= 26 && bytes.toString('ascii', 0, 2) === 'BM') {
    const dib = bytes.readUInt32LE(14)
    return dib === 12
      ? { width: bytes.readUInt16LE(18), height: bytes.readUInt16LE(20) }
      : dib >= 40
        ? { width: bytes.readInt32LE(18), height: Math.abs(bytes.readInt32LE(22)) }
        : undefined
  }
  if (
    bytes.length >= 6 &&
    (bytes.readUInt32LE(0) === 0x00010000 || bytes.readUInt32LE(0) === 0x00020000)
  ) {
    const count = bytes.readUInt16LE(4)
    if (!count || bytes.length < 6 + count * 16) return undefined
    let width = 0,
      height = 0
    for (let i = 0; i < count; i++) {
      width = Math.max(width, bytes[6 + i * 16] || 256)
      height = Math.max(height, bytes[7 + i * 16] || 256)
    }
    return { width, height }
  }
  return undefined
}
