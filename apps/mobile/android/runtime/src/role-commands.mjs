// Agent Roles settings with the native identity; a request cannot select another account/workspace.
const actions = new Set(['list', 'save', 'delete']);
const known = new Set(['role_read_only', 'role_conflict', 'role_duplicate', 'role_forbidden', 'role_target_unavailable', 'role_invalid']);
export function roleCommands(runtime, identity) {
 return {
  async agentRoleSettings(input, signal) {
   signal?.throwIfAborted();
   const scope = identity();
   if (!scope?.workspaceId || !scope?.userId) return {error:'not_connected'};
   if (!input || !actions.has(input.action)) return {error:'role_invalid'};
   try {
    return await runtime.agentRoles({...input, workspaceId:scope.workspaceId, userId:scope.userId});
   } catch (error) {
    // A closed vocabulary; an unrecognised write failure may have landed.
    const code = String(error?.message ?? '');
    return {error:known.has(code) ? code : input.action === 'list' ? 'role_load_failed' : 'role_write_unknown'};
   }
  },
 };
}
