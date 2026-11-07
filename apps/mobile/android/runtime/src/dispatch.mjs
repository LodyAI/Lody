// Android adaptation around the unchanged shared command names.
export const HOST_PROTOCOL = 2;
export const CORE_CAPABILITIES = ['ping', 'setActive', 'probeSchema'];
export function createDispatcher(runtime, emit, diagnostics) {
  const pending = new Map();
  return async request => {
    if (!request || typeof request !== 'object') return;
    const {id, method, args = []} = request;
    if (typeof id !== 'string' || !id.length || id.length > 80 || !Array.isArray(args)) return;
    if (method === '$cancel') {
      const item = pending.get(args[0]);
      if (item) { item.cancelled = true; item.controller.abort(); pending.delete(args[0]); }
      return;
    }
    if (pending.has(id)) { emit({type:'bridgeError',code:'duplicate_request'}); return; }
    const control = method === "ping" || method === "setActive";
    if (pending.size >= 32 || (!control && [...pending.values()].filter(item=>!item.control).length >= 30)) { emit({type:'reply',id,error:'too_many_commands'}); return; }
    const item = {cancelled:false, control, controller:new AbortController()};
    let invoke;
    switch (method) {
      case 'ping': if(args.length===0) invoke=()=>runtime.ping(); break;
      case 'setActive': if(args.length===1 && typeof args[0]==='boolean') invoke=()=>runtime.setActive(args[0]); break;
      case 'probeSchema': if(args.length===0) invoke=()=>runtime.probeSchema(); break;
      default:
        if (diagnostics && Object.hasOwn(diagnostics, method)) invoke=()=>diagnostics[method](...args,item.controller.signal);
        else { emit({type:'reply',id,error:'unsupported_command'}); return; }
    }
    if (!invoke) { emit({type:'reply',id,error:'invalid_arguments'}); return; }
    pending.set(id,item);
    try {
      const value=(await invoke()) ?? null;
      if (!item.cancelled) emit({type:'reply',id,value});
    } catch {
      if (!item.cancelled) emit({type:'reply',id,error:'runtime_command_failed'});
    } finally { if(pending.get(id)===item) pending.delete(id); }
  };
}
