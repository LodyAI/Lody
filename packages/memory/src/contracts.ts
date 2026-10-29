import type {
  MemoryIdentity,
  MemoryMutationContext,
  MemoryChangeRecord,
  MemoryListInput,
  MemorySearchInput,
  MemoryReadInput,
  MemoryCreateInput,
  MemoryUpdateInput,
  MemoryForgetInput,
} from './schema';

/** Expected failures carry stable codes, not plaintext content or raw storage errors. */
export type MemoryFailureCode =
  | 'invalid_input'
  | 'not_found'
  | 'path_exists'
  | 'limit_exceeded'
  | 'invalid_document'
  | 'unsupported_format'
  | 'scope_mismatch';
export type MemoryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: MemoryFailureCode } };

export interface MemoryDocumentSummary {
  readonly path: string;
  readonly description?: string;
  readonly createdAt: number;
}
export interface MemoryPage<T> {
  readonly items: readonly T[];
  /** Offset into the current live result order; not a snapshot. */
  readonly nextOffset?: number;
}
export interface MemoryReadPage {
  readonly document: MemoryDocumentSummary;
  readonly body: string;
  /** Offsets and limits count Unicode code points, not UTF-16 code units or bytes. */
  readonly nextOffset?: number;
}
export interface MemorySearchHit {
  readonly document: MemoryDocumentSummary;
  readonly matchedFields: readonly ('path' | 'description' | 'body')[];
  readonly excerpt: string;
}
export interface MemoryChange {
  readonly path: string;
  readonly changeId: string;
}
export interface MemoryProvenance extends MemoryChangeRecord {
  readonly changeId: string;
}
/** A document's body just before and after one recorded change; absent where it did not exist. */
export interface MemoryRevision {
  readonly before?: string;
  readonly after?: string;
}
export interface MemoryStartupContext {
  /** Fixed application instructions, kept separate from reference data. */
  readonly instructions: string;
  readonly entry?: MemoryReadPage;
}

/**
 * Synchronous API over ONE already-authorized, caller-owned LoroDoc.
 * Identity is checked once at open; the host preserves the Doc binding and admits imports.
 * Host code rechecks access before every invocation. Successful mutations are
 * in-memory changes, NOT saves.
 * Host awaits its existing Repo durability barrier before returning success to UI/MCP.
 * No method opens another memory or routes filesystem/network/session requests.
 */
export interface MemoryDocument {
  readonly identity: Readonly<MemoryIdentity>;
  startup(): MemoryResult<MemoryStartupContext>;
  list(input: MemoryListInput): MemoryResult<MemoryPage<MemoryDocumentSummary>>;
  search(input: MemorySearchInput): MemoryResult<MemoryPage<MemorySearchHit>>;
  read(input: MemoryReadInput): MemoryResult<MemoryReadPage>;
  /** Accept a logical path or [[wiki/path]]. */
  resolve(link: string): MemoryResult<MemoryDocumentSummary>;
  provenance(path: string, input: MemoryListInput): MemoryResult<MemoryPage<MemoryProvenance>>;
  /** Bodies around one change, from tagged Loro history. Untagged older changes: `not_found`. */
  revision(path: string, changeId: string): MemoryResult<MemoryRevision>;
  /** Ensure a path and write its content; host supplies unique change IDs and provenance. */
  create(input: MemoryCreateInput, context: MemoryMutationContext): MemoryResult<MemoryChange>;
  /** Edit existing live state; newPath migrates content to a new path identity. */
  update(input: MemoryUpdateInput, context: MemoryMutationContext): MemoryResult<MemoryChange>;
  forget(input: MemoryForgetInput, context: MemoryMutationContext): MemoryResult<MemoryChange>;
}

/** Host-level status; it is not persisted in the MemoryDoc or inferred from commit(). */
export type MemorySyncStatus =
  | { state: 'unavailable'; reason: 'local_only' | 'encrypted_sync_not_ready' }
  | { state: 'pending' }
  | { state: 'synced' };
export interface MemorySaveReceipt {
  readonly change: MemoryChange;
  readonly local: 'saved';
  readonly sync: MemorySyncStatus;
}
