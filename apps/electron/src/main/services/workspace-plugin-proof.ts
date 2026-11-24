import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pluginManifestSchema, type PluginManifest } from '@lody/shared/plugins/manifest-schema'
import { MAX_PACKED_CLIENT_BUNDLE_BYTES, unpackClientBundle } from '@lody/shared/plugins/digest'

export const scopeHash = (parts: readonly string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
export type WorkspaceModuleOperation = { action: 'approve' | 'forget' } | { action: 'open'; bytes: Uint8Array; names: Record<string,string[]> }
type Evidence = { manifest: PluginManifest; digest?: string; dev: boolean }
function canonical(value: unknown): unknown {
  return Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v])=>[k,canonical(v)])) : value
}
/** Store admission evidence, never executable bytes. The caller derives directory from native custody. */
const pending = new Map<string, Promise<unknown>>()
export async function workspaceModuleProof(directory:string, raw:PluginManifest, digest:string, op:WorkspaceModuleOperation, evidence:()=>Promise<Evidence>, current:()=>boolean):Promise<string|null>{
  const key = JSON.stringify([directory, raw.id]); const prior = pending.get(key)
  const work = (prior ?? Promise.resolve()).catch(()=>{}).then(()=>applyProof(directory,raw,digest,op,evidence,current))
  pending.set(key,work)
  try {return await work} finally {if(pending.get(key)===work)pending.delete(key)}
}
async function applyProof(directory:string, raw:PluginManifest, digest:string, op:WorkspaceModuleOperation, evidence:()=>Promise<Evidence>, current:()=>boolean):Promise<string|null>{
  const m=pluginManifestSchema.parse(raw)
  if(!current()||!m.client||m.machine||[m.skills,m.agentRoles,m.mcpServers,m.acpProviders].some(c=>c?.length)||!/^[a-f0-9]{64}$/.test(digest)) throw Error('Invalid workspace release')
  const path=join(directory,m.id+'.json'), proof=JSON.stringify([digest,canonical(m)])
  if(op.action==='approve'){
    const row=await evidence()
    if(row.dev||row.digest!==digest||JSON.stringify([digest,canonical(row.manifest)])!==proof||!current())throw Error('Workspace release differs from native catalog')
    await mkdir(directory,{recursive:true,mode:0o700}); const tmp=path+'.'+randomUUID()
    try{await writeFile(tmp,proof,{mode:0o600,flag:'wx'});if(!current())throw Error('Reader retired');await rename(tmp,path)}finally{await rm(tmp,{force:true})}return null
  }
  let stored:string;try{stored=await readFile(path,'utf8')}catch(e){if(op.action==='forget'&&(e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e}
  if(stored!==proof||!current())throw Error('Workspace release not approved')
  if(op.action==='forget'){await rm(path,{force:true});return null}
  if(op.action!=='open'||!(op.bytes instanceof Uint8Array)||op.bytes.length>MAX_PACKED_CLIENT_BUNDLE_BYTES||createHash('sha256').update(op.bytes).digest('hex')!==digest)throw Error('Workspace bundle integrity failure')
  return new TextDecoder('utf-8',{fatal:true}).decode(unpackClientBundle(op.bytes)(m.client))
}
