// Prompt shortcut settings with the native identity; a request cannot select another account/workspace.
const actions = new Set(['list', 'read', 'save']);
const known = new Set(['shortcut_changed', 'invalid_shortcut', 'shortcut_index_pending', 'shortcut_limit']);
export function shortcutCommands(runtime, identity) {
 return {
  async shortcutSettings(input, signal) {
   signal?.throwIfAborted();
   const scope = identity();
   if (!scope?.workspaceId || !scope?.userId) return {error:'not_connected'};
   if (!input || !actions.has(input.action)) return {error:'invalid_shortcut'};
   try {
    return await runtime.promptShortcuts({...input, workspaceId:scope.workspaceId, userId:scope.userId});
   } catch (error) {
    // A closed vocabulary; any other save failure may have landed, so it is unknown, never replayed.
    const code = String(error?.message ?? '');
    if (known.has(code)) return {error:code};
    return {error:input.action === 'save' ? 'shortcut_write_unknown' : 'shortcut_load_failed'};
   }
  },
 };
}
