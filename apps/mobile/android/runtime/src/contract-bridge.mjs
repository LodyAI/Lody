// Translate Android's native command surface to the shared runtime envelope contract.
export function contractBridge(runtime, emit) {
 const pending=new Map(), grants=new Map(); let serial=0, workspace='';
 const receive=envelope=>runtime.receive(JSON.stringify(envelope));
 function call(method,payload={}) {
  const id=`android-${++serial}`;
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{pending.delete(id);reject(Error('runtime_timeout'));},method==='editSession' || method==='forkSession' ? 130000 : method==='scheduleCommand' ? 75000 : 45000);
   pending.set(id,{resolve,reject,timer,method});
   receive({v:1,gen:1,kind:'request',id,method,payload});
  });
 }
 function message(message) {
  if(message.type!=='envelope')return false;
  const e=typeof message.envelope==='string'?JSON.parse(message.envelope):message.envelope;
  if(e.gen!==1)return true;
  if(e.kind==='result'||e.kind==='error') {
   const p=pending.get(e.id);if(!p||p.method!==e.method)return true;
   clearTimeout(p.timer);pending.delete(e.id);
   if(e.kind==='error')p.reject(Error(e.error.code));else p.resolve(e.payload);
  } else if(e.kind==='event')emit({type:e.method,...e.payload,...(e.method==='machinePresence'?{presence:JSON.stringify(e.payload)}:{})});
  else if(e.kind==='request') {
   if(e.method==='grant'){grants.set(e.id,e);emit({type:'grant'});}
   else receive({...e,kind:'error',payload:undefined,error:{code:'unsupported_method',retryable:false}});
  }
  return true;
 }
 globalThis.androidRuntimeMessage=message;
 const ready=call('hello',{protocol:1,gen:1});
 const invoke=async(method,payload)=>{await ready;return call(method,payload);};
 return {
  ping:async()=>{await invoke('ping');return true;},
  setActive:async active=>{await invoke('setActive',{active});return true;},
  start:async(workspaceId,userId='',active=false)=>{workspace=workspaceId;await invoke('start',{workspaceId,userId,active});return true;},
  probeSchema:()=>workspace?invoke('probeSchema',{workspaceId:workspace}):ready.then(()=>({creationOptionsTrial:{},machines:{}})),
  session:id=>invoke('openSession',{sessionId:id}),
  loadOlderSession:args=>invoke('loadOlderSession',args),
  forgetPendingInput:args=>invoke('forgetPendingInput',args),
  retryPendingInput:args=>invoke('retryPendingInput',args),
  ensureSession:args=>invoke('ensureSession',args),
  creationOptions:args=>invoke('creationOptions',args),
  createSession:args=>invoke('createSession',args),
  editSession:args=>invoke('editSession',args),
  forkSession:args=>invoke('forkSession',args),
  setTabClosed:args=>invoke('setTabClosed',args),
  createTab:args=>invoke('createTab',args),
  // Agent Roles readable by this user, listed for the new-chat Role row.
  agentRoles:args=>invoke('agentRoles',args),
  // The composer's @ panel: one mention category for a session.
  mentionCatalog:args=>invoke('mentionCatalog',args),
  // Add a local folder as a project: list computers, browse a computer's folders, register one.
  localProjects:args=>invoke('localProjects',args),
  // Prompt shortcuts: the readable index and one body (for writing a chosen shortcut into the composer).
  promptShortcuts:args=>invoke('promptShortcuts',args),
  // Multi-repository projects for the new-chat picker.
  projectGroups:args=>invoke('projectGroups',args),
  // A changed file's text before and after one turn, read from the session's computer.
  turnDiff:args=>invoke('turnDiff',args),
  // Schedules: the list with time zones, one schedule's detail, and owner writes (the runtime's 70 s budget).
  schedules:args=>invoke('schedules',args),
  scheduleDetail:args=>invoke('scheduleDetail',args),
  scheduleCommand:args=>invoke('scheduleCommand',args),
  grant(value){for(const e of grants.values())receive(value?{...e,kind:'result',payload:value}:{...e,kind:'error',payload:undefined,error:{code:'grant_unavailable',retryable:true}});grants.clear();return true;},
 };
}
