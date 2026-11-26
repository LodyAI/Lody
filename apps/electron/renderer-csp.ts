import type { Plugin } from 'vite'

type CloudRendererEnvironment = Record<string, string | undefined>

const HOSTED_LORO_STREAMS_CONNECT_SOURCES = [
  'https://*.streams-api-x.loro.dev',
  'wss://*.streams-api-x.loro.dev'
] as const
const GITHUB_API_CONNECT_SOURCES = [
  'https://api.github.com',
  'https://raw.githubusercontent.com'
] as const
const REMOTE_AVATAR_SOURCES = [
  'https://avatars.githubusercontent.com',
  'https://lh3.googleusercontent.com',
  'https://cdn.discordapp.com',
  'https://secure.gravatar.com'
] as const
const CSP_META_PATTERN = /<meta\b(?=[^>]*\bhttp-equiv="Content-Security-Policy")[^>]*>/i
const CSP_CONTENT_PATTERN = /\bcontent="([^"]*)"/i

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  )
}

function readHttpOrigin(
  env: CloudRendererEnvironment,
  key: string,
  options: { required: boolean }
): string | null {
  const rawValue = env[key]?.trim()
  if (!rawValue) {
    if (options.required) {
      throw new Error(`Electron cloud CSP requires ${key}`)
    }
    return null
  }

  let url: URL
  try {
    url = new URL(rawValue)
  } catch (error) {
    throw new Error(`Electron cloud CSP requires ${key} to be an absolute URL`, {
      cause: error
    })
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Electron cloud CSP requires ${key} to use http: or https:`)
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw new Error(`Electron cloud CSP requires non-loopback ${key} to use https:`)
  }
  if (url.username || url.password) {
    throw new Error(`Electron cloud CSP does not accept credentials in ${key}`)
  }
  return url.origin
}

function toWebSocketOrigin(httpOrigin: string): string {
  const url = new URL(httpOrigin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.origin
}

function appendDirectiveSources(
  policy: string,
  additions: Readonly<Record<string, readonly string[]>>
): string {
  const directives = policy
    .split(';')
    .map((directive) => directive.trim())
    .filter(Boolean)
    .map((directive) => directive.split(/\s+/))

  for (const [name, sources] of Object.entries(additions)) {
    const matches = directives.filter(([directiveName]) => directiveName === name)
    if (matches.length !== 1) {
      throw new Error(
        `Electron cloud CSP expected exactly one ${name} directive, found ${matches.length}`
      )
    }
    const directive = matches[0]
    if (!directive) {
      throw new Error(`Electron cloud CSP could not resolve its ${name} directive`)
    }
    for (const source of sources) {
      if (!directive.includes(source)) {
        directive.push(source)
      }
    }
  }

  return `${directives.map((directive) => directive.join(' ')).join('; ')};`
}

function injectCloudRendererCsp(
  html: string,
  additions: Readonly<Record<string, readonly string[]>>
): string {
  const metaMatch = html.match(CSP_META_PATTERN)
  if (!metaMatch) {
    throw new Error('Electron cloud renderer entry is missing its CSP meta tag')
  }

  const meta = metaMatch[0]
  const contentMatch = meta.match(CSP_CONTENT_PATTERN)
  if (!contentMatch) {
    throw new Error('Electron cloud renderer CSP meta tag requires a double-quoted content value')
  }

  const policy = contentMatch[1]
  if (policy === undefined) {
    throw new Error('Electron cloud renderer CSP meta tag has no content value')
  }
  const nextPolicy = appendDirectiveSources(policy, additions)
  const nextMeta = meta.replace(CSP_CONTENT_PATTERN, `content="${nextPolicy}"`)
  return html.replace(meta, nextMeta)
}

export function cloudRendererCspHtmlPlugin(options: { env: CloudRendererEnvironment }): Plugin {
  const convexSiteOrigin = readHttpOrigin(options.env, 'VITE_CONVEX_SITE_URL', {
    required: true
  })
  const convexDeployOrigin = readHttpOrigin(options.env, 'VITE_CONVEX_DEPLOY_URL', {
    required: true
  })
  const serverOrigin = readHttpOrigin(options.env, 'VITE_SERVER_URL', { required: true })
  const postHogOrigin = readHttpOrigin(options.env, 'VITE_PUBLIC_POSTHOG_HOST', {
    required: false
  })
  const apiOrigin = readHttpOrigin(options.env, 'VITE_API_BASE_URL', { required: false })
  const configuredStreamsOrigin = readHttpOrigin(options.env, 'VITE_LORO_STREAMS_BASE_URL', {
    required: false
  })

  if (!convexSiteOrigin || !convexDeployOrigin || !serverOrigin) {
    throw new Error('Electron cloud CSP required-origin validation failed')
  }

  const connectSources = [
    convexSiteOrigin,
    convexDeployOrigin,
    toWebSocketOrigin(convexDeployOrigin),
    serverOrigin,
    ...HOSTED_LORO_STREAMS_CONNECT_SOURCES,
    ...GITHUB_API_CONNECT_SOURCES,
    ...REMOTE_AVATAR_SOURCES,
    ...(postHogOrigin ? [postHogOrigin] : []),
    ...(apiOrigin ? [apiOrigin] : []),
    ...(configuredStreamsOrigin
      ? [configuredStreamsOrigin, toWebSocketOrigin(configuredStreamsOrigin)]
      : [])
  ]

  return {
    name: 'lody-electron-cloud-renderer-csp',
    enforce: 'pre',
    transformIndexHtml(html, context) {
      if (context.path.endsWith('/recovery.html') || context.path.endsWith('/pr-image.html')) {
        return html
      }
      return injectCloudRendererCsp(html, {
        'connect-src': connectSources,
        'img-src': [serverOrigin, ...(apiOrigin ? [apiOrigin] : []), ...REMOTE_AVATAR_SOURCES],
        'frame-src': ['https://*.trycloudflare.com']
      })
    }
  }
}
