import { resolveSessionFilePath } from '@lody/shared';
import fs from 'fs';
import path from 'path';

import type { AcpStandardDiffBlockEvidence } from '@/lib/acp/history';
import type { CodeCollabV2DiffStoreEvent } from './code-collab-v2-diff-store';

export type CodeCollabV2PendingDiffStoreEvent = CodeCollabV2DiffStoreEvent & {
  /**
   * `standard-null` follows ACP semantics for creation, but some adapters have reported
   * `oldText: null` before later sending a real replacement. Let later strong evidence repair it.
   */
  readonly oldTextEvidence: 'strong' | 'standard-null';
};

export type CodeCollabV2WriteTextFileEvidence = {
  readonly path: string;
  readonly oldText: string | null;
  readonly newText: string;
};

export type CodeCollabV2ResolvedEvidencePath = {
  readonly absolutePath: string;
  readonly relativePath: string;
};

export type NormalizeStandardDiffEvidenceInput = {
  readonly workspaceRoot: string;
  readonly diff: AcpStandardDiffBlockEvidence;
  readonly readCurrentText?: (absolutePath: string) => Promise<string | null>;
};

export function pendingEventFromWriteTextFileEvidence(
  evidence: CodeCollabV2WriteTextFileEvidence
): CodeCollabV2PendingDiffStoreEvent {
  return {
    path: evidence.path,
    oldText: evidence.oldText,
    newText: evidence.newText,
    oldTextEvidence: 'strong',
  };
}

export async function pendingEventFromStandardDiffEvidence(
  input: NormalizeStandardDiffEvidenceInput
): Promise<CodeCollabV2PendingDiffStoreEvent | null> {
  const resolved = resolveCodeCollabV2EvidencePath(input.workspaceRoot, input.diff.path);
  if (!resolved) {
    return null;
  }

  const readCurrentText = input.readCurrentText ?? readUtf8TextIfExists;
  const currentText = await readCurrentText(resolved.absolutePath);

  if (input.diff.oldText === null) {
    if (currentText !== null && currentText !== input.diff.newText) {
      return null;
    }
    return {
      path: resolved.absolutePath,
      oldText: null,
      newText: currentText ?? input.diff.newText,
      oldTextEvidence: 'standard-null',
    };
  }

  if (currentText === null) {
    return null;
  }

  if (input.diff.newText === currentText) {
    return {
      path: resolved.absolutePath,
      oldText: input.diff.oldText,
      newText: currentText,
      oldTextEvidence: 'strong',
    };
  }

  const reconstructedOldText = reconstructOldTextFromSingleReplacement({
    currentText,
    oldFragment: input.diff.oldText,
    newFragment: input.diff.newText,
  });
  if (reconstructedOldText === null) {
    return null;
  }

  return {
    path: resolved.absolutePath,
    oldText: reconstructedOldText,
    newText: currentText,
    oldTextEvidence: 'strong',
  };
}

export type AgentEditEvidenceForDiffStore = {
  readonly path: string;
  readonly changeType: 'update' | 'add' | 'delete';
  readonly contentOldText?: string | undefined;
  readonly oldString?: string | undefined;
  readonly newString?: string | undefined;
};

export type AgentEditLatestText =
  | { readonly status: 'tracked'; readonly text: string | null }
  | { readonly status: 'too_large'; readonly rawBytes: number }
  | { readonly status: 'untracked' };

/**
 * Build a diff-store event for an edit-tool change (Codex `apply_patch` et al) that bypasses
 * `fs/write_text_file` and standard ACP diff blocks. `newText` is the file's CURRENT content;
 * `oldText` is resolved in priority order — exact agent-reported pre-image, single-fragment
 * reverse, then CHAINING from the previous recorded state for this path (`latestText`).
 * Missing pre-image for a first-seen update is not recoverable at this layer; returning a
 * synthetic `old === new` event would persist a fake +0/-0 turn diff and hide the broken capture.
 */
export async function pendingEventFromAgentEditEvidence(input: {
  readonly workspaceRoot: string;
  readonly edit: AgentEditEvidenceForDiffStore;
  readonly latestText: AgentEditLatestText;
  readonly readCurrentText?: (absolutePath: string) => Promise<string | null>;
}): Promise<CodeCollabV2PendingDiffStoreEvent | null> {
  const resolved = resolveCodeCollabV2EvidencePath(input.workspaceRoot, input.edit.path);
  if (!resolved) {
    return null;
  }
  const readCurrentText = input.readCurrentText ?? readUtf8TextIfExists;
  const newText =
    input.edit.changeType === 'delete' ? null : await readCurrentText(resolved.absolutePath);
  // An update/add whose file we cannot read (deleted out from under us, binary, etc.) carries
  // no usable new side — skip rather than record a bogus event.
  if (newText === null && input.edit.changeType !== 'delete') {
    return null;
  }

  const old = resolveAgentEditOldText({
    edit: input.edit,
    currentText: newText,
    latestText: input.latestText,
  });
  if (!old) {
    return null;
  }

  return {
    path: resolved.absolutePath,
    oldText: old.text,
    newText,
    oldTextEvidence: old.evidence,
  };
}

function resolveAgentEditOldText(input: {
  readonly edit: AgentEditEvidenceForDiffStore;
  readonly currentText: string | null;
  readonly latestText: AgentEditLatestText;
}): { readonly text: string | null; readonly evidence: 'strong' | 'standard-null' } | null {
  const { edit, currentText, latestText } = input;
  // 1. Agent reported the full pre-image (most accurate for this turn).
  if (typeof edit.contentOldText === 'string') {
    return { text: edit.contentOldText, evidence: 'strong' };
  }
  // 2. Single fragment replacement we can reverse against the current file.
  if (edit.oldString !== undefined && edit.newString !== undefined && currentText !== null) {
    const reconstructed = reconstructOldTextFromSingleReplacement({
      currentText,
      oldFragment: edit.oldString,
      newFragment: edit.newString,
    });
    if (reconstructed !== null) {
      return { text: reconstructed, evidence: 'strong' };
    }
  }
  // 3. Chain from the previous recorded "new" for this path.
  if (latestText.status === 'tracked') {
    return { text: latestText.text, evidence: 'strong' };
  }
  // 4. First-ever capture of a created file: the old side is "absent".
  if (edit.changeType === 'add') {
    return { text: null, evidence: 'strong' };
  }
  // 5. Untracked delete with no pre-image: nothing to show.
  if (edit.changeType === 'delete') {
    return null;
  }
  return null;
}

export function mergePendingDiffStoreEvents(
  events: readonly CodeCollabV2PendingDiffStoreEvent[]
): CodeCollabV2DiffStoreEvent[] {
  const byPath = new Map<string, CodeCollabV2PendingDiffStoreEvent>();
  for (const event of events) {
    const existing = byPath.get(event.path);
    if (!existing) {
      byPath.set(event.path, event);
      continue;
    }

    const shouldReplaceOldText =
      existing.oldTextEvidence === 'standard-null' && event.oldTextEvidence === 'strong';
    byPath.set(event.path, {
      path: event.path,
      oldText: shouldReplaceOldText ? event.oldText : existing.oldText,
      newText: event.newText,
      oldTextEvidence: shouldReplaceOldText ? event.oldTextEvidence : existing.oldTextEvidence,
    });
  }
  return [...byPath.values()].map(({ path: eventPath, oldText, newText }) => ({
    path: eventPath,
    oldText,
    newText,
  }));
}

export function resolveCodeCollabV2EvidencePath(
  workspaceRoot: string,
  evidencePath: string
): CodeCollabV2ResolvedEvidencePath | null {
  if (!evidencePath || evidencePath.includes('\0')) {
    return null;
  }

  const root = path.resolve(workspaceRoot);
  const realRoot = realpathOrSelf(root);
  const absolutePath = path.isAbsolute(evidencePath)
    ? path.resolve(evidencePath)
    : path.resolve(root, evidencePath);
  const realAbsolutePath = realpathOrSelf(absolutePath);
  for (const candidatePath of uniqueStrings([absolutePath, realAbsolutePath])) {
    for (const candidateRoot of uniqueStrings([root, realRoot])) {
      const relativePath = normalizeRelativePath(candidateRoot, candidatePath);
      if (relativePath) {
        return {
          absolutePath: candidatePath,
          relativePath,
        };
      }
    }
  }
  return null;
}

function reconstructOldTextFromSingleReplacement(options: {
  readonly currentText: string;
  readonly oldFragment: string;
  readonly newFragment: string;
}): string | null {
  const { currentText, oldFragment, newFragment } = options;
  if (newFragment.length === 0) {
    return null;
  }

  let index = currentText.indexOf(newFragment);
  if (index < 0) {
    return null;
  }
  if (currentText.indexOf(newFragment, index + newFragment.length) >= 0) {
    return null;
  }

  return currentText.slice(0, index) + oldFragment + currentText.slice(index + newFragment.length);
}

async function readUtf8TextIfExists(absolutePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(absolutePath, 'utf8');
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'EISDIR')) {
      return null;
    }
    throw error;
  }
}

function realpathOrSelf(inputPath: string): string {
  try {
    return fs.realpathSync.native(inputPath);
  } catch {
    const parent = path.dirname(inputPath);
    if (parent !== inputPath) {
      const realParent = realpathOrSelf(parent);
      if (realParent !== parent) {
        return path.join(realParent, path.basename(inputPath));
      }
    }
    return inputPath;
  }
}

function normalizeRelativePath(root: string, candidatePath: string): string | null {
  const parsed = resolveSessionFilePath([{ id: 'main', absolutePath: root }], candidatePath);
  return parsed?.relativePath ? path.posix.normalize(parsed.relativePath.normalize('NFC')) : null;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
