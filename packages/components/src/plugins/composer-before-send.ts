import { extractPromptPreviewFromInputBlocks, type SessionInputBlock } from '@lody/shared';
import type { ClientPluginRegistry } from '@lody/plugin-sdk/client';
type Handler = Parameters<ClientPluginRegistry['composer']['beforeSend']>[0];
const hooks = new Set<{ workspace: string; signal: AbortSignal; value: Handler }>();
export function registerComposerTransform(workspace: string, signal: AbortSignal, value: Handler) {
  signal.throwIfAborted();
  const entry = { workspace, signal, value };
  hooks.add(entry);
  signal.addEventListener('abort', () => hooks.delete(entry), { once: true });
}
export function hasComposerTransforms(workspace: string) {
  return [...hooks].some((e) => e.workspace === workspace);
}
async function transformComposerText(workspace: string, text: string, cancelled: AbortSignal) {
  const expires = performance.now() + 3000;
  const deadline = AbortSignal.timeout(3000);
  cancelled.throwIfAborted();
  for (const owner of [...hooks]) {
    if (owner.workspace !== workspace) continue;
    const signal = AbortSignal.any([cancelled, owner.signal, deadline]);
    signal.throwIfAborted();
    let rejectAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(signal.reason);
    });
    signal.addEventListener('abort', rejectAbort, { once: true });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return owner.value({ text, signal });
        }),
        aborted,
      ]);
      signal.throwIfAborted();
      if (performance.now() >= expires)
        throw new DOMException('Plugin transformation timed out', 'TimeoutError');
      if (result !== undefined) {
        if (typeof result !== 'string') throw Error('Invalid plugin draft transformation');
        text = result;
      }
    } finally {
      signal.removeEventListener('abort', rejectAbort);
    }
  }
  return text;
}

/** Run only after mention expansion and first-turn instructions have produced the execution text. */
export async function prepareComposerText(
  workspace: string,
  effective: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
  confirm: (text: string) => boolean
) {
  const text = await transformComposerText(workspace, effective, signal);
  signal.throwIfAborted();
  if (!isCurrent()) return;
  if (text === effective) return { changed: false, text: effective };
  const canonical = text.trim();
  if (canonical === effective) return { changed: false, text: effective };
  if (confirm(canonical)) return { changed: true, text: canonical };
}
export function confirmPluginPrompt(text: string) {
  return window.confirm(`Send this plugin-modified message?\n\n${text}`);
}

/** Escape cancels a pending transformation without cancelling the plugin installation. */
export async function prepareInteractivePrompt(
  workspace: string,
  effective: string,
  owner: AbortSignal,
  isCurrent = () => true
) {
  owner.throwIfAborted();
  if (!hasComposerTransforms(workspace)) return { text: effective, changed: false };
  const escape = new AbortController();
  const stop = (event: KeyboardEvent) => {
    if (event.key === 'Escape') escape.abort();
  };
  window.addEventListener('keydown', stop);
  try {
    return await prepareComposerText(
      workspace,
      effective,
      AbortSignal.any([owner, escape.signal]),
      isCurrent,
      confirmPluginPrompt
    );
  } finally {
    window.removeEventListener('keydown', stop);
  }
}

/** The agent configuration and Role precede the task only on a new session's first turn. */
export async function prepareFirstComposerInput(options: {
  workspace: string;
  inputBlocks: SessionInputBlock[];
  configPrompt?: string;
  rolePrompt?: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
}) {
  const authored = extractPromptPreviewFromInputBlocks(options.inputBlocks);
  const effective = [options.configPrompt, options.rolePrompt, authored]
    .filter((part) => part?.trim())
    .join('\n\n');
  const result = await prepareInteractivePrompt(
    options.workspace,
    effective,
    options.signal,
    options.isCurrent
  );
  if (!result) return;
  if (!result.changed) return { prompt: effective, inputBlocks: options.inputBlocks };
  const blocks = options.inputBlocks.filter((b) => b.type !== 'text') as SessionInputBlock[];
  if (result.text) blocks.push({ type: 'text', text: result.text });
  return { prompt: result.text, inputBlocks: blocks };
}
