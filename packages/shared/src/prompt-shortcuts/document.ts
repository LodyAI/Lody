import { LoroDoc } from 'loro-crdt';
import { z } from 'zod';
import { parsePromptShortcut } from './compiler';
import { PromptShortcutError, type PromptShortcut } from './model';

const revisionSchema = z
  .object({
    parents: z.array(z.string().min(1)).max(100),
  })
  .strict();

type SavedRevision = { parents: string[] };

/**
 * Saves are immutable coherent values, not independently merged text/ranges.
 * Explicit parent revisions retain concurrent saves instead of silently choosing
 * a LWW winner. A conflict must be resolved before projecting or invoking it.
 */
export class PromptShortcutDocument {
  constructor(readonly doc: LoroDoc) {}

  private revisions(): Map<string, SavedRevision> {
    const result = new Map<string, SavedRevision>();
    for (const [id, value] of this.doc.getMap('revisions').entries()) {
      const parsed = revisionSchema.safeParse(value);
      if (!parsed.success)
        throw new PromptShortcutError('invalid_template', 'Invalid saved revision');
      if (
        new Set(parsed.data.parents).size !== parsed.data.parents.length ||
        parsed.data.parents.includes(id)
      ) {
        throw new PromptShortcutError('invalid_template', 'Invalid revision ancestry');
      }
      result.set(id, { parents: parsed.data.parents });
    }
    return result;
  }

  heads(): PromptShortcut[] {
    const revisions = this.revisions();
    const parentIds = new Set<string>();
    const children = new Map<string, string[]>();
    const degree = new Map<string, number>();
    for (const [id, revision] of revisions) {
      degree.set(id, revision.parents.length);
      for (const parent of revision.parents) {
        if (!revisions.has(parent))
          throw new PromptShortcutError('revision_pending', 'Revision ancestry has not arrived');
        parentIds.add(parent);
        const list = children.get(parent) ?? [];
        list.push(id);
        children.set(parent, list);
      }
    }
    const queue = [...degree].filter(([, count]) => count === 0).map(([id]) => id);
    for (let i = 0; i < queue.length; i++) {
      for (const child of children.get(queue[i]) ?? []) {
        const remaining = degree.get(child)! - 1;
        degree.set(child, remaining);
        if (remaining === 0) queue.push(child);
      }
    }
    if (queue.length !== revisions.size)
      throw new PromptShortcutError('invalid_template', 'Cyclic revision ancestry');
    const heads = [...revisions.keys()]
      .filter((id) => !parentIds.has(id))
      .map((id) => {
        const value = this.doc.getMap('contents').get(id);
        if (value === undefined)
          throw new PromptShortcutError('revision_pending', 'Revision content has not arrived');
        const content = parsePromptShortcut(value);
        if (content.revision !== id)
          throw new PromptShortcutError('invalid_template', 'Revision key mismatch');
        return content;
      })
      .sort((a, b) => a.revision.localeCompare(b.revision));
    const first = heads.at(0);
    if (
      first &&
      heads.some(
        (head) =>
          head.id !== first.id ||
          head.workspaceId !== first.workspaceId ||
          head.ownerUserId !== first.ownerUserId ||
          head.visibility !== first.visibility ||
          head.createdAt !== first.createdAt
      )
    ) {
      throw new PromptShortcutError('invalid_template', 'Document identity cannot change');
    }
    return heads;
  }

  read(): PromptShortcut | null {
    const heads = this.heads();
    if (heads.length > 1)
      throw new PromptShortcutError(
        'conflict',
        'Concurrent saves require an explicit resolution',
        heads.map((head) => head.revision)
      );
    return heads[0] ?? null;
  }

  /** Non-mutating validation; callers can validate before persisting a write intent. */
  validateSave(value: unknown, expectedParents: readonly string[]): PromptShortcut {
    const content = parsePromptShortcut(value);
    if (!revisionSchema.safeParse({ parents: [...expectedParents] }).success) {
      throw new PromptShortcutError('invalid_template', 'Invalid revision ancestry');
    }
    const revisions = this.revisions();
    const previous = revisions.get(content.revision);
    if (previous) {
      const savedValue = this.doc.getMap('contents').get(content.revision);
      if (
        savedValue !== undefined &&
        JSON.stringify(parsePromptShortcut(savedValue)) === JSON.stringify(content) &&
        JSON.stringify([...previous.parents].sort()) === JSON.stringify([...expectedParents].sort())
      ) {
        const heads = this.heads();
        if (heads.length !== 1 || heads[0]?.revision !== content.revision) {
          throw new PromptShortcutError('conflict', 'A saved branch cannot hide a concurrent head');
        }
        return content;
      }
      throw new PromptShortcutError('conflict', 'A revision id cannot be reused');
    }
    const heads = this.heads();
    const actualParents = heads.map((head) => head.revision).sort();
    if (JSON.stringify(actualParents) !== JSON.stringify([...expectedParents].sort())) {
      throw new PromptShortcutError(
        'conflict',
        'The document changed since editing started',
        actualParents
      );
    }
    const current = heads.at(0);
    if (
      current &&
      (current.id !== content.id ||
        current.workspaceId !== content.workspaceId ||
        current.ownerUserId !== content.ownerUserId ||
        current.visibility !== content.visibility ||
        current.createdAt !== content.createdAt)
    ) {
      throw new PromptShortcutError('invalid_template', 'Document identity cannot change');
    }
    return content;
  }

  save(value: unknown, expectedParents: readonly string[]): PromptShortcut {
    const content = this.validateSave(value, expectedParents);
    if (this.doc.getMap('revisions').get(content.revision) !== undefined) return content;
    this.doc.getMap('contents').set(content.revision, JSON.parse(JSON.stringify(content)));
    this.doc.getMap('revisions').set(content.revision, { parents: [...expectedParents] });
    // Only live branch bodies belong in materialized state. The small ancestry DAG
    // detects conflicts without decoding every historical long Prompt on each read.
    for (const parent of expectedParents) this.doc.getMap('contents').delete(parent);
    this.doc.commit();
    return content;
  }

  /** Sharing exports the current value into a fresh history, never the private CRDT snapshot. */
  static fromPublishedState(value: unknown): PromptShortcutDocument {
    const result = new PromptShortcutDocument(new LoroDoc());
    result.save(value, []);
    return result;
  }
}
