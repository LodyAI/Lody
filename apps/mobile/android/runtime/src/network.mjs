import {expandMentions} from '../vendor/cloud-runtime/src/runtime/mention-expansion.ts';
import {referenceSpans} from '../vendor/cloud-runtime/src/protocol/message-references.ts';
import {contractBridge} from './contract-bridge.mjs';
import '../vendor/cloud-runtime/src/runtime/index.ts';
import {createDispatcher,HOST_PROTOCOL,CORE_CAPABILITIES} from './dispatch.mjs';
import {createReadAccess} from './read-access.mjs';
import {createCommands,billingEntitlement} from './create-commands.mjs';
import {controlTurn,itemDetail,respondPermission,sendTurn,stopSessions} from '../vendor/cloud-runtime/src/runtime/session.ts';
import {cloudCommands} from './cloud-commands.mjs';
import {providerCommands} from './provider-commands.mjs';
import {roleCommands} from './role-commands.mjs';
import {shortcutCommands} from './shortcut-commands.mjs';
import {scheduleCommands} from './schedule-commands.mjs';
import {proposalCommands} from './proposal-commands.mjs';
const emit=message=>globalThis.webkit.messageHandlers.dataRuntime.postMessage(message);
const access=createReadAccess(globalThis.fetch.bind(globalThis),emit);
globalThis.fetch=access.fetch;
// Bundled Streams uses fetch. Other outbound APIs have no permission in this host.
globalThis.XMLHttpRequest=undefined;globalThis.WebSocket=undefined;globalThis.EventSource=undefined;
const runtime=contractBridge(globalThis.dataRuntime,emit);
const core={ping:()=>runtime.ping(),probeSchema:()=>runtime.probeSchema(),setActive:active=>{access.setActive(active);if(!active)stopSessions();return runtime.setActive(active);}};
const cloud=cloudCommands(runtime,access,stopSessions);
// Native answers a shortcutCloud request it received as an event.
cloud.shortcutCloudReply=(requestId,reply)=>runtime.shortcutCloud(requestId,reply);
// Native answers a previewToken request (a preview proof's request token) it received as an event.
cloud.previewTokenReply=(requestId,reply)=>runtime.previewToken(requestId,reply);
let identity;
const connect=cloud.connect;cloud.connect=(workspaceId,gateway,userId)=>{const result=connect(workspaceId,gateway,userId);identity={workspaceId,userId};return result;};
// A tool step's detail (command, output, diff) reads the watched session's local replica only.
const detail={
 setTabClosed:(sessionId,closed)=>{if(!identity)throw Error("not_connected");return runtime.setTabClosed({workspaceId:identity.workspaceId,sessionId,closed});},
 // Archive or unarchive a conversation (iOS `SessionWrite.archive`); a write, never retried.
 archiveSession:(sessionId,archived)=>{if(!identity)throw Error("not_connected");if(typeof archived!=='boolean')throw Error('invalid_action');return runtime.archiveSession({workspaceId:identity.workspaceId,sessionId,archived});},
 messageAction: (kind, input) => {
  if (!identity || !input || !['edit','fork'].includes(kind) || !['read','send'].includes(input.action)) throw Error('invalid_action');
  const args={...input,workspaceId:identity.workspaceId,userId:identity.userId,billingEntitlement:billingEntitlement(input.billingEntitlement)};
  return kind==='edit' ? runtime.editSession(args) : runtime.forkSession(args);
 },
 createTab:async(parentSessionId,sessionId,title,preferRoost,entitlement)=>{const scope=identity;if(!scope)throw Error('not_connected');const result=await runtime.createTab({workspaceId:scope.workspaceId,parentSessionId,sessionId,title,preferRoost:preferRoost===true,billingEntitlement:billingEntitlement(entitlement)});return {state:result.state,...(result.state==='rejected'&&typeof result.reason==='string'?{reason:result.reason}:{})};},
 loadOlderSession:sessionId=>runtime.loadOlderSession({sessionId}),
 retryPendingInput:(sessionId,inputId)=>runtime.retryPendingInput({sessionId,inputId}),
 forgetPendingInput:(sessionId,inputId)=>runtime.forgetPendingInput({sessionId,inputId}),
 itemDetail:(sessionId,entryId,itemId)=>itemDetail({sessionId,entryId,itemId}),turnDiff:(sessionId,entryId,path)=>runtime.turnDiff({sessionId,entryId,path}),
 // Browse files: a folder of the session's local project (relative to its root) and a file's contents (relative to the session's directory). Reads only.
 listDir:(sessionId,relativePath)=>{const scope=identity;if(!scope)throw Error('not_connected');return runtime.listDir({workspaceId:scope.workspaceId,sessionId,relativePath,userId:scope.userId});},
 readFile:(sessionId,path)=>runtime.readFile({sessionId,path}),
 // Previews of a session, always for the verified identity: the managed web preview (`create` /
 // `revoke`) and the iOS Simulator / Android Emulator lifecycle (list / start / status / stop).
 sessionPreview:(sessionId,action)=>{const scope=identity;if(!scope)throw Error('not_connected');if(!['create','revoke'].includes(action))throw Error('invalid_action');return runtime.sessionPreview({sessionId,userId:scope.userId,action});},
 iosSimulatorControl:(sessionId,command)=>{const scope=identity;if(!scope)throw Error('not_connected');return runtime.iosSimulatorControl({workspaceId:scope.workspaceId,sessionId,userId:scope.userId,command});},
 androidEmulatorControl:(sessionId,command)=>{const scope=identity;if(!scope)throw Error('not_connected');return runtime.androidEmulatorControl({workspaceId:scope.workspaceId,sessionId,userId:scope.userId,command});},
 // Stops the watched session's running turn; a write, never retried.
 controlTurn:async(sessionId,machineId,turnId)=>{const result=await controlTurn({action:'stop',sessionId,machineId,turnId});return {state:result?.state??'unknown'};},
 // Answers a permission request (a plan approval) in the watched session; a write, never retried.
 // `{state}` is accepted / stale / conflict; failures travel in-band as `{error: code}`.
 respondPermission:async(sessionId,entryId,itemId,requestId,optionId)=>{
  try{const result=await respondPermission({sessionId,entryId,itemId,requestId,optionId});return {state:result.state};}
  catch(error){const code=String(error?.message??'');return {error:['session_not_ready','workspace_changed','invalid_option','upload_failed'].includes(code)?code:'permission_write_failed'};}
 }};
const sendWithReferences = args => sendTurn(args, async text => {
 const items = [];
 const expanded = await expandMentions(text, async category => {
  const catalog = await runtime.mentionCatalog({workspaceId:identity.workspaceId,sessionId:args.sessionId,machineId:args.machineId,userId:args.userId,cliType:args.cliType,agentType:args.agentType,category});
  items.push(...catalog.items);
  return catalog;
 });
 return {text:expanded,spans:referenceSpans(expanded,items)};
});
globalThis.androidDispatch=createDispatcher(core,emit,{...cloud,...createCommands(runtime,sendWithReferences,()=>identity),...scheduleCommands(runtime,()=>identity),...proposalCommands(runtime,()=>identity),...providerCommands(runtime,()=>identity),...roleCommands(runtime,()=>identity),...shortcutCommands(runtime,()=>identity),...detail});
emit({type:'hostReady',protocol:HOST_PROTOCOL,capabilities:[...CORE_CAPABILITIES,'connect','grant','watchSession','closeSession','loadOlderSession','forgetPendingInput','retryPendingInput','creationOptions','createAndSend','sendText','turnQuota','itemDetail','createTab','turnDiff','listDir','readFile','controlTurn','respondPermission','agentRoles','mentionCatalog','localProjects','shortcutBody','projectGroups','messageAction','setTabClosed','archiveSession','schedules','scheduleDetail','scheduleCommand','decideProposal','agentProviders','agentProviderDetail','agentProviderProbe','agentProviderAuth','agentProviderOperation','agentRoleSettings','shortcutCloudReply','shortcutSettings','sessionPreview','iosSimulatorControl','androidEmulatorControl','previewTokenReply']});
