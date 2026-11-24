import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { LoroDocumentManager } from '../lib/loro/doc';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES } from '@lody/plugin-sdk';
import type { SessionBackend } from '../session/session-backend';

/** Construct only from dispatcher-owned records. repositoryDirectory is the current
 * device identity's repository, never a plugin dataDir or an MCP argument. */
export interface PluginResultCustody {
  readonly documents: Pick<LoroDocumentManager, 'pluginResultRepository'>;
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly history: SessionBackend;
  readonly authorize: (operation: 'read' | 'complete') => Promise<void>;
  readonly signal: AbortSignal;
}

function database(repository: string) {
  const db = new DatabaseSync(join(repository, 'plugin-turn-results.sqlite'));
  db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS results(session TEXT NOT NULL, turn TEXT NOT NULL, call TEXT NOT NULL, sha TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(session,turn,call))');
  return db;
}
const invalid = () => Object.assign(new Error('Invalid plugin tool result'), { code: 'validation_failed' });
const forbidden = () => Object.assign(new Error('Plugin result unavailable'), { code: 'forbidden' });
async function check(c: PluginResultCustody, op: 'read' | 'complete') {
  const [meta,row] = await Promise.all([c.history.getMetaState(),c.history.readTurn(c.turnId)]);
  if (meta?.id !== c.sessionId || row.state !== 'ready' || row.turn.role !== 'assistant' || (op === 'complete' && (row.turn.finished || meta.isArchived))) throw forbidden();
  await c.authorize(op);
  c.signal.throwIfAborted();
  return row.turn;
}
function reference(c: Pick<PluginResultCustody,'toolCallId'>, sha256: string, body: string) {
  return { type: 'plugin-tool-artifact' as const, toolCallId: c.toolCallId, sha256, bytes: Buffer.byteLength(body), preview: body.slice(0, 256) }; 
}
/** Call after output-schema validation. Return only the same bounded JSON text written to history. */
export async function persistPluginToolResult(c: PluginResultCustody, validatedOutput: unknown): Promise<string> {
  const body = JSON.stringify(validatedOutput);
  if (body === undefined) throw invalid();
  const bytes = Buffer.byteLength(body,'utf8');
  if (bytes > 2 * 1024 * 1024) throw invalid();
  await check(c,'complete');
  const key = JSON.stringify([c.documents.pluginResultRepository,c.sessionId,c.turnId,c.toolCallId]);
  pending.set(key,(pending.get(key) ?? 0)+1);
  try {
  let text = body;
  if (bytes > MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES) {
    const sha = createHash('sha256').update(body).digest('hex');
    const db = database(c.documents.pluginResultRepository);
    try {
      db.prepare('INSERT INTO results VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING').run(c.sessionId,c.turnId,c.toolCallId,sha,body);
      if (!db.prepare('SELECT 1 FROM results WHERE session=? AND turn=? AND call=? AND sha=?').get(c.sessionId,c.turnId,c.toolCallId,sha)) throw invalid();
    } finally { db.close(); }
    text = JSON.stringify(reference(c,sha,body));
  }
  await c.history.applyAgentBatch({targetAssistantEntryId:c.turnId,entryBound:true,operationIds:[`plugin-result:${c.toolCallId}`],contents:[{type:'text',text:bytes > MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES ? `\n${text}\n` : text}]});
  await c.history.flushLocalWrites();
  return text;
  } finally { const left=(pending.get(key) ?? 1)-1;if(left)pending.set(key,left);else pending.delete(key); }
}
const pending=new Map<string,number>();
export async function readPluginToolResult(c: PluginResultCustody, sha256: string): Promise<string> {
  const turn = await check(c,'read');
  const db = database(c.documents.pluginResultRepository);
  try {
    const body=db.prepare('SELECT body FROM results WHERE session=? AND turn=? AND call=? AND sha=?').get(c.sessionId,c.turnId,c.toolCallId,sha256)?.body;
    if(typeof body!=='string') throw forbidden();
    const ref=JSON.stringify(reference(c,sha256,body));
    if(!containsReference(turn.items,ref)) throw forbidden();
    return body;
  } finally { db.close(); }
}
/** Called only after the history owner durably deletes the turn or session. */
export function forgetPluginToolResults(repositoryDirectory:string,sessionId:string,turnId?:string) {
  if (!existsSync(join(repositoryDirectory,'plugin-turn-results.sqlite'))) return;
  const db=database(repositoryDirectory);
  try { if(turnId===undefined) db.prepare('DELETE FROM results WHERE session=?').run(sessionId); else db.prepare('DELETE FROM results WHERE session=? AND turn=?').run(sessionId,turnId); } finally {db.close();}
}

// History normalizes adjacent text deltas. References are complete JSON lines, not item boundaries.
function containsReference(items: readonly unknown[] | undefined, ref:string) {
  let text='';
  for(const item of items ?? []) {
    if(item && typeof item==='object' && 'type' in item && item.type==='text' && 'text' in item && typeof item.text==='string') text+=item.text;
    else {if(text.split('\n').includes(ref))return true;text='';}
  }
  return text.split('\n').includes(ref);
}
export async function collectReplacedPluginResults(repository:string,sessionId:string,history:SessionBackend){
  if(!existsSync(join(repository,'plugin-turn-results.sqlite')))return;
  const db=database(repository);
  try {
    const keys=db.prepare('SELECT turn,call,sha FROM results WHERE session=?').all(sessionId);
    for(const {turn,call,sha} of keys){
      if(typeof turn!=='string'||typeof call!=='string'||typeof sha!=='string')continue;
      const row=await history.readTurn(turn);
      if(row.state!=='missing'&&row.state!=='ready')continue;
      if(pending.has(JSON.stringify([repository,sessionId,turn,call])))continue;
      const body=db.prepare('SELECT body FROM results WHERE session=? AND turn=? AND call=? AND sha=?').get(sessionId,turn,call,sha)?.body;
      if(typeof body!=='string')continue;
      if(row.state==='ready'&&containsReference(row.turn.items,JSON.stringify(reference({toolCallId:call},sha,body))))continue;
      db.prepare('DELETE FROM results WHERE session=? AND turn=? AND call=? AND sha=?').run(sessionId,turn,call,sha);
    }
  } finally {db.close();}
}
