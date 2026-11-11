// Translate Android's native command surface to the shared runtime envelope contract.
export function contractBridge(runtime, emit) {
 const pending=new Map(), grants=new Map(), clouds=new Map(), tokens=new Map(); let serial=0, workspace='';
 // Prompt shortcut Convex calls the runtime asks the native host to make (iOS `shortcutCloud`).
 const cloudOperations=new Set(['listAccessibleDocuments','getStreamToken','stageDocument','activateDocument']);
 const receive=envelope=>runtime.receive(JSON.stringify(envelope));
 function call(method,payload={}) {
  const id=`android-${++serial}`;
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{pending.delete(id);reject(Error('runtime_timeout'));},method==='agentProviderOperation' ? 355000 : method==='agentProviderAuth' ? 65000 : method==='agentProviderProbe' || method==='agentProviders' ? 140000 : method==='editSession' || method==='forkSession' || method==='promptShortcuts' ? 130000 : method==='scheduleCommand' ? 75000 : method==='sessionPreview' ? 335000 : method==='iosSimulatorControl' || method==='androidEmulatorControl' ? 105000 : 45000);
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
   else if(e.method==='shortcutCloud' && workspace && e.payload?.workspaceId===workspace && cloudOperations.has(e.payload.operation) && clouds.size<8) {
    // Always answered: native replies within its own deadline, or this fails it (e.g. backgrounded).
    clouds.set(e.id,{e,timer:setTimeout(()=>shortcutCloud(e.id,null),75000)});
    emit({type:'shortcutCloud',requestId:e.id,operation:e.payload.operation,args:JSON.stringify(e.payload.args??{})});
   }
   else if(e.method==='shareRequest' && e.payload?.operation==='previewToken' && workspace && e.payload.workspaceId===workspace && e.payload.args?.intent?.workspaceId===workspace && tokens.size<4) {
    // A preview proof's request token (iOS `SessionSharing.previewToken`): native mints it with the
    // verified account. Always answered: native replies within its own deadline, or this fails it.
    tokens.set(e.id,{e,timer:setTimeout(()=>previewToken(e.id,null),60000)});
    emit({type:'previewToken',requestId:e.id,intent:JSON.stringify(e.payload.args.intent)});
   }
   else receive({...e,kind:'error',payload:undefined,error:{code:'unsupported_method',retryable:false}});
  }
  return true;
 }
 // The native reply to one shortcutCloud request: {value} on success, null on any failure.
 function shortcutCloud(requestId,reply){
  const item=clouds.get(requestId);if(!item)return false;clouds.delete(requestId);clearTimeout(item.timer);
  const e=item.e;
  if(reply && typeof reply==='object' && Object.hasOwn(reply,'value'))receive({...e,kind:'result',payload:{value:reply.value}});
  else receive({...e,kind:'error',payload:undefined,error:{code:'shortcut_unavailable',retryable:false}});
  return true;
 }
 // The native reply to one previewToken request: {value} (the token, or {status} for an HTTP refusal), null on any failure.
 function previewToken(requestId,reply){
  const item=tokens.get(requestId);if(!item)return false;tokens.delete(requestId);clearTimeout(item.timer);
  const e=item.e, value=reply && typeof reply==='object' ? reply.value : undefined;
  const valid=(typeof value==='string' && value.length>0 && value.length<=8192) || (value && typeof value==='object' && Number.isInteger(value.status));
  if(valid)receive({...e,kind:'result',payload:{value:typeof value==='string'?value:{status:value.status}}});
  else receive({...e,kind:'error',payload:undefined,error:{code:'preview_token_unavailable',retryable:false}});
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
  ensureSession:args=>invoke('ensureSession',args),
  creationOptions:args=>invoke('creationOptions',args),
  createSession:args=>invoke('createSession',args),
  editSession:args=>invoke('editSession',args),
  forkSession:args=>invoke('forkSession',args),
  setTabClosed:args=>invoke('setTabClosed',args),
  createTab:args=>invoke('createTab',args),
  // Agent Roles readable by this user, listed for the new-chat Role row.
  agentProviders:args=>invoke('agentProviders',args),
  agentProviderDetail:args=>invoke('agentProviderDetail',args),
  agentProviderProbe:args=>invoke('agentProviderProbe',args),
  agentProviderAuth:args=>invoke('agentProviderAuth',args),
  agentProviderOperation:args=>invoke('agentProviderOperation',args),
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
  // The browse-files sheet: one folder of the session's local project, and one file's contents.
  listDir:args=>invoke('listDir',args),
  readFile:args=>invoke('readFile',args),
  // Schedules: the list with time zones, one schedule's detail, and owner writes (the runtime's 70 s budget).
  schedules:args=>invoke('schedules',args),
  scheduleDetail:args=>invoke('scheduleDetail',args),
  scheduleCommand:args=>invoke('scheduleCommand',args),
  // Managed web preview (create / revoke) and device previews (list / start / status / stop); results carry {error} in band.
  sessionPreview:args=>invoke('sessionPreview',args),
  iosSimulatorControl:args=>invoke('iosSimulatorControl',args),
  androidEmulatorControl:args=>invoke('androidEmulatorControl',args),
  shortcutCloud,
  previewToken,
  grant(value){for(const e of grants.values())receive(value?{...e,kind:'result',payload:value}:{...e,kind:'error',payload:undefined,error:{code:'grant_unavailable',retryable:true}});grants.clear();return true;},
 };
}
