// Native identity is authoritative; provider requests cannot select another account/workspace.
const actions = new Set(['list', 'save', 'delete', 'refresh', 'retrySetup', 'deleteSetup']);
export function providerCommands(runtime, identity) {
 const extra = Object.fromEntries(['agentProviderDetail','agentProviderProbe','agentProviderAuth','agentProviderOperation'].map(method => [method, async (input, signal) => {
  signal?.throwIfAborted();
  const scope=identity();
  if (!scope?.workspaceId || !scope?.userId) return {error:'not_connected'};
  try { return await runtime[method]({...input, workspaceId:scope.workspaceId,userId:scope.userId}); }
  catch { return {error:method==='agentProviderDetail' ? 'provider_load_failed' : 'provider_write_unknown'}; }
 }]));
 return {
  ...extra,
  async agentProviders(input, signal) {
   signal?.throwIfAborted();
   const scope = identity();
   if (!scope?.workspaceId || !scope?.userId) return {error:'not_connected'};
   if (!input || !actions.has(input.action)) return {error:'invalid_request'};
   try {
    return await runtime.agentProviders({...input, workspaceId:scope.workspaceId, userId:scope.userId});
   } catch (error) {
    // Keep a closed vocabulary; never forward backend text or credential-bearing diagnostics.
    const code = String(error?.message ?? '');
    const known = new Set(['setting_conflict','setting_read_only','provider_conflict','provider_read_only','provider_not_owner','provider_offline','provider_setup_unsupported','invalid_provider','provider_not_found']);
    return {error:known.has(code) ? code : input.action === 'list' ? 'provider_load_failed' : 'provider_write_unknown'};
   }
  },
 };
}
