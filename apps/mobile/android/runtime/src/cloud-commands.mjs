export function cloudCommands(runtime, access, stopSessions) {
 let connected=false, selected;
 return {
  connect(workspaceId,gatewayBaseUrl,userId) {
   if(connected)throw Error('already_connected');
   if(userId!==undefined && (typeof userId!=='string' || !userId.trim() || userId.length>128))throw Error('invalid_identity');
   access.configure({workspaceId,gatewayBaseUrl});
   connected=true;
   // The verified native identity enables presence for creation; offline probes omit it.
   return runtime.start(workspaceId,userId,Boolean(userId));
  },
  watchSession(id) {
   if(!connected)throw Error('not_connected');
   if(typeof id!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))throw Error('invalid_session');
   stopSessions();selected=id;
   return runtime.session(id);
  },
  closeSession(id) {
   if(selected===id){stopSessions();selected=undefined;}
   return true;
  },
  grant(value) {
   if(value!==null && (!value || typeof value.token!=='string' || typeof value.gatewayBaseUrl!=='string' || !Number.isFinite(value.expiresIn) || value.expiresIn<=0))throw Error('invalid_grant');
   runtime.grant(value);return true;
  },
 };
}
