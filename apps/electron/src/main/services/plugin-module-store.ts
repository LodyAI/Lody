import { randomUUID } from 'node:crypto'

const deps = new Set([
  'react',
  'react/jsx-runtime',
  'zod',
  '@lody/ui',
  '@lody/plugin-sdk',
  '@lody/plugin-sdk/client',
  '@lody/plugin-sdk/manifest'
])
const modules = new Map<string, { owner: number; source: string }>()
export function releasePluginModules(owner: number) {
  for (const [url, item] of modules) if (item.owner === owner) modules.delete(url)
}
export function releasePluginModule(owner: number, url: string) {
  if (modules.get(url)?.owner === owner) modules.delete(url)
}
/** Source is read from an enabled daemon-cataloged package, never supplied by the renderer. */
export async function publishPluginModule(
  owner: number,
  source: string,
  names: Record<string, string[]>
) {
  const { init, parse } = await import('es-module-lexer')
  await init
  const root = `lody-plugin://module/${randomUUID()}/`
  const bridges = new Map<string, string>()
  for (const i of [...parse(source)[0]].reverse()) {
    if (i.d === -2) continue
    if (i.d !== -1 || !i.n || !deps.has(i.n) || !Object.hasOwn(names, i.n))
      throw Error('Unsupported plugin import')
    const path = root + encodeURIComponent(i.n) + '.js'
    const exports = names[i.n]!
    if (
      !Array.isArray(exports) ||
      exports.length > 4096 ||
      !exports.every((k) => typeof k === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k))
    )
      throw Error('Invalid host dependency exports')
    bridges.set(
      path,
      `const mod=globalThis[Symbol.for(${JSON.stringify('lody.client.external.' + i.n)})];\n` +
        exports
          .map((k, n) => `const v${n}=mod[${JSON.stringify(k)}];export {v${n} as ${k}};`)
          .join('\n')
    )
    source = source.slice(0, i.s) + path + source.slice(i.e)
  }
  const url = root + 'client.js'
  bridges.set(url, source)
  for (const [path, text] of bridges) modules.set(path, { owner, source: text })
  return url
}
export function releasePluginGraph(owner: number, url: string) {
  if (modules.get(url)?.owner !== owner) return
  const root = new URL('.', url).href
  for (const key of modules.keys()) if (key.startsWith(root)) releasePluginModule(owner, key)
}
export function respondPluginModule(request: Request) {
  const entry = modules.get(request.url)
  return entry && request.method === 'GET'
    ? new Response(entry.source, {
        headers: {
          'Content-Type': 'text/javascript',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        }
      })
    : new Response(null, { status: 404 })
}
