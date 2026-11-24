import { randomBytes } from 'node:crypto'
import { createReadStream, realpathSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { z } from 'zod'
import { resolveFilePreviewPath } from '@lody/shared/node/file-preview-path-policy'

export const HTML_PREVIEW_SCHEME = 'lody-html-preview'

export const LocalHtmlPreviewRequestSchema = z
  .object({
    machineId: z.string().min(1),
    path: z.string().min(1),
    workspaceRoot: z.string().nullable().optional(),
    allowScripts: z.boolean(),
    allowWorkspaceResources: z.boolean().optional()
  })
  .strict()

export type LocalHtmlPreviewRequest = z.infer<typeof LocalHtmlPreviewRequestSchema>

export type LocalHtmlPreviewResult =
  | { readonly status: 'ok'; readonly url: string }
  | { readonly status: 'error'; readonly code: string; readonly message: string }

type Site = { owner: number; root: string; allowScripts: boolean }

/** True for a preview document URL or origin (`lody-html-preview://<token>`). */
export function isHtmlPreviewUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && url.toLowerCase().startsWith(`${HTML_PREVIEW_SCHEME}://`)
}

/**
 * A preview frame stays on preview content: it may not replace itself with a
 * web page (which would then run inside Lody's window) or any other scheme.
 */
export function blocksHtmlPreviewFrameNavigation(
  frameUrl: string | null | undefined,
  targetUrl: string
): boolean {
  return isHtmlPreviewUrl(frameUrl) && !isHtmlPreviewUrl(targetUrl)
}

/** Permission requests from preview pages are always refused. */
export function isHtmlPreviewPermissionRequester(
  ...urls: ReadonlyArray<string | null | undefined>
): boolean {
  return urls.some(isHtmlPreviewUrl)
}

const MAX_SITES_PER_OWNER = 32

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg'
}

/**
 * Serves a local HTML file and its sibling resources from a per-preview origin
 * (`lody-html-preview://<random token>/`). The token is the only capability:
 * it never encodes a filesystem path, only reaches files under the authorized
 * resource directory, and dies with the renderer document that requested it.
 */
export class LocalHtmlPreviewSites {
  private readonly sites = new Map<string, Site>()

  releaseOwner(owner: number) {
    for (const [token, site] of this.sites) if (site.owner === owner) this.sites.delete(token)
  }

  /** `absolutePath` must already be symlink-resolved and authorized by the caller. */
  open(
    owner: number,
    absolutePath: string,
    allowScripts: boolean,
    root = dirname(absolutePath)
  ): string {
    const owned = [...this.sites].filter(([, site]) => site.owner === owner)
    if (owned.length >= MAX_SITES_PER_OWNER) this.sites.delete(owned[0][0])
    const token = randomBytes(16).toString('hex')
    this.sites.set(token, { owner, root, allowScripts })
    return `${HTML_PREVIEW_SCHEME}://${token}/${relative(root, absolutePath).split(sep).map(encodeURIComponent).join('/')}`
  }

  async respond(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(null, { status: 405 })
    const url = new URL(request.url)
    const site = this.sites.get(url.hostname)
    if (!site) return new Response(null, { status: 404 })
    const target = await resolveSiteFile(site.root, url.pathname)
    if (!target) return new Response(null, { status: 404 })
    const headers: Record<string, string> = {
      'Content-Type': MIME_TYPES[extname(target.path).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': String(target.size),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // The frame's sandbox already withholds scripts when the user did not
      // allow them; the header keeps that true even if the URL is reused.
      ...(site.allowScripts
        ? {}
        : { 'Content-Security-Policy': "script-src 'none'; object-src 'none'" })
    }
    if (request.method === 'HEAD') return new Response(null, { headers })
    const stream = createReadStream(target.path)
    request.signal.addEventListener('abort', () => stream.destroy(), { once: true })
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers })
  }
}

async function resolveSiteFile(root: string, pathname: string) {
  const segments: string[] = []
  for (const raw of pathname.split('/')) {
    if (!raw) continue
    let segment: string
    try {
      segment = decodeURIComponent(raw)
    } catch {
      return null
    }
    // Dot segments are traversal or hidden files (`.env`, `.git`); neither is page content.
    if (segment.startsWith('.') || /[\\/\0]/u.test(segment)) return null
    segments.push(segment)
  }
  if (segments.length === 0) return null
  try {
    const resolved = await realpath(join(root, ...segments))
    if (!resolved.startsWith(root.endsWith(sep) ? root : root + sep)) return null
    // A visible symlink (`config.txt -> .env`) must not reach a hidden file either.
    if (
      relative(root, resolved)
        .split(sep)
        .some((part) => part.startsWith('.'))
    )
      return null
    const info = await stat(resolved)
    return info.isFile() ? { path: resolved, size: info.size } : null
  } catch {
    return null
  }
}

/** Null means this desktop cannot serve the target; no path has been inspected. */
export function openLocalHtmlPreview(
  sites: LocalHtmlPreviewSites,
  owner: number,
  request: LocalHtmlPreviewRequest,
  localMachineId: string | null
): LocalHtmlPreviewResult | null {
  if (!localMachineId || request.machineId !== localMachineId) return null
  if (request.workspaceRoot != null && !isAbsolute(request.workspaceRoot))
    return {
      status: 'error',
      code: 'invalid_path',
      message: 'The session workspace must be an absolute path.'
    }
  if (!/\.html?$/iu.test(request.path))
    return { status: 'error', code: 'invalid_path', message: 'Only HTML files can be previewed.' }
  const resolution = resolveFilePreviewPath({
    requestedPath: request.path,
    workspaceRoot: request.workspaceRoot ?? null,
    options: { allowArbitraryPaths: true }
  })
  if (!resolution.ok) return { status: 'error', ...resolution.rejection }
  const { absolutePath } = resolution.resolved
  let root = dirname(absolutePath)
  if (request.allowWorkspaceResources) {
    if (!request.workspaceRoot || resolution.resolved.external)
      return {
        status: 'error',
        code: 'path_not_allowed',
        message: 'The HTML file must be inside the selected workspace.'
      }
    try {
      root = realpathSync.native(request.workspaceRoot)
    } catch {
      return {
        status: 'error',
        code: 'workspace_root_unavailable',
        message: 'The selected workspace is unavailable.'
      }
    }
    const prefix = root.endsWith(sep) ? root : root + sep
    if (!absolutePath.startsWith(prefix))
      return {
        status: 'error',
        code: 'path_not_allowed',
        message: 'The HTML file is outside the selected workspace.'
      }
  }
  return {
    status: 'ok',
    url: sites.open(owner, absolutePath, request.allowScripts, root)
  }
}
