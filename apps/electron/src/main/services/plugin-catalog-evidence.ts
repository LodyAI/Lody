import { pluginRpcResultSchema } from '@lody/shared/plugins/machine-rpc'
import { createHash } from 'node:crypto'
import { unpackClientBundle, MAX_PACKED_CLIENT_BUNDLE_BYTES } from '@lody/shared/plugins/digest'

// The reader map belongs to the native account/workspace; navigation also rotates the document key.
const catalogs = new WeakMap<
  object,
  WeakMap<object, Map<string, Map<string, { digest: string; client: string }>>>
>()
export function observePluginCatalog(
  reader: object,
  document: object,
  machine: string,
  result: unknown
) {
  const reply = pluginRpcResultSchema.parse(result)
  if (reply.type !== 'plugin/catalog') throw Error('Invalid native catalog reply')
  let docs = catalogs.get(reader)
  if (!docs) {
    docs = new WeakMap()
    catalogs.set(reader, docs)
  }
  let machines = docs.get(document)
  if (!machines) {
    machines = new Map()
    docs.set(document, machines)
  }
  machines.set(
    machine,
    new Map(
      reply.installations.flatMap((i) =>
        i.enabled && i.clientDigest && i.manifest.client
          ? [[i.manifest.id, { digest: i.clientDigest, client: i.manifest.client }]]
          : []
      )
    )
  )
}
export function openAuthenticatedPluginSource(
  reader: object,
  document: object,
  machine: string,
  id: string,
  digest: string,
  bytes: Uint8Array
) {
  const item = catalogs.get(reader)?.get(document)?.get(machine)?.get(id)
  if (
    !item ||
    digest !== item.digest ||
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength > MAX_PACKED_CLIENT_BUNDLE_BYTES ||
    createHash('sha256').update(bytes).digest('hex') !== digest
  )
    throw Error('No matching authenticated plugin bundle')
  return new TextDecoder('utf-8', { fatal: true }).decode(unpackClientBundle(bytes)(item.client))
}
