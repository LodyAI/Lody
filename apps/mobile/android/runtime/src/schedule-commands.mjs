// Android adapter over the shared runtime's `schedules`, `scheduleDetail` and `scheduleCommand`.
// The dispatcher collapses thrown errors into one code, so failures travel in-band as
// `{error: code}`: schedule codes pass through for localized messages; anything else on a write
// is `schedule_write_unknown` (the outcome is not known, so nothing here retries).
const CODES = new Set([
 'schedule_not_found','schedule_not_owner','schedule_machine_unsupported','schedule_prompt_invalid',
 'schedule_trigger_invalid','schedule_title_invalid','schedule_message_read_only','schedule_deleted',
 'schedule_conflict','schedule_invalid','schedule_write_unknown','metadata_not_ready','workspace_changed',
]);
const ACTIONS = ['create','edit','pause','resume','run','delete'];
const KEY = /^[A-Za-z0-9_-]{1,50}$/;
const RULES = ['manual','once','minutes','hours','daily','weekdays','weekly','monthly','unsupported'];
const text = (value, max) => typeof value === 'string' && value.length <= max;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128;

function validDraft(draft) {
 if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return false;
 if (!text(draft.title, 200) || !text(draft.prompt, 32000) || !id(draft.machineId) || !id(draft.agentConfigId)) return false;
 if (!['new_session','own_session'].includes(draft.destination)) return false;
 for (const key of ['modelId','modeId']) if (draft[key] !== undefined && !id(draft[key])) return false;
 const rule = draft.rule;
 if (!rule || typeof rule !== 'object' || !RULES.includes(rule.kind) || JSON.stringify(rule).length > 4096) return false;
 const project = draft.project;
 if (project !== undefined && (!project || typeof project !== 'object' || !['local','github'].includes(project.kind) || JSON.stringify(project).length > 4096)) return false;
 return true;
}

export function scheduleCommands(runtime, identity) {
 const workspace = () => { const scope = identity(); return scope?.userId ? scope.workspaceId : undefined; };
 const failure = (error, fallback) => { const code = String(error?.message ?? ''); return {error: CODES.has(code) ? code : fallback}; };
 return {
  // The workspace's schedules with the device and machines' time zones; a read.
  async schedules() {
   const workspaceId = workspace(); if (!workspaceId) return {error:'not_connected'};
   try { return await runtime.schedules({workspaceId}); } catch (error) { return failure(error, 'schedule_load_failed'); }
  },
  // One schedule with its prompt, model, mode and project; a read.
  async scheduleDetail(scheduleId) {
   const workspaceId = workspace(); if (!workspaceId) return {error:'not_connected'};
   if (typeof scheduleId !== 'string' || !KEY.test(scheduleId)) return {error:'invalid_request'};
   try { return await runtime.scheduleDetail({workspaceId, scheduleId}); } catch (error) { return failure(error, 'schedule_load_failed'); }
  },
  // A write. `requestId` is the caller's idempotency key: new per intent, reused only to retry
  // the same attempt after `schedule_write_unknown`. Never retried here.
  async scheduleCommand(input, signal) {
   signal?.throwIfAborted();
   const workspaceId = workspace(); if (!workspaceId) return {error:'not_connected'};
   if (!input || !ACTIONS.includes(input.action) || !KEY.test(input.scheduleId ?? '') || !KEY.test(input.requestId ?? '')) return {error:'invalid_request'};
   const writesDraft = input.action === 'create' || input.action === 'edit';
   if (writesDraft ? !validDraft(input.draft) : input.draft !== undefined) return {error:'invalid_request'};
   try {
    return await runtime.scheduleCommand({workspaceId, action:input.action, scheduleId:input.scheduleId, requestId:input.requestId, ...(writesDraft ? {draft:input.draft} : {})});
   } catch (error) { return failure(error, 'schedule_write_unknown'); }
  },
 };
}
