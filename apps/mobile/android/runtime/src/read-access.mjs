/** Network permission comes only from the native-validated workspace grant. */
export function createReadAccess(fetch, emit=()=>{}) {
 let config, active=true;
 const requests=new Set(), waiters=new Set();
 function configure(value) {
  const gateway=new URL(value.gatewayBaseUrl);
  if(gateway.protocol!=='https:' || gateway.username || gateway.password || gateway.search || gateway.hash || gateway.port) throw Error('network_denied');
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(value.workspaceId)) throw Error('network_denied');
  config={origin:gateway.origin,prefix:gateway.pathname.replace(/\/$/, '')+'/ds/lody/',workspace:value.workspaceId};
 }
 function allowed(request) {
  const url=new URL(request.url);
  if(!config || !['GET','HEAD','POST','PUT'].includes(request.method) || url.origin!==config.origin || url.username || url.password || url.hash || !url.pathname.startsWith(config.prefix)) return false;
  const parts=url.pathname.slice(config.prefix.length).split('/');
  if(parts.length>2 || (parts.length===2 && parts[1]!=='bootstrap')) return false;
  let stream;try{stream=decodeURIComponent(parts[0])}catch{return false}
  const read=['GET','HEAD'].includes(request.method);
  if(parts.length===2 && !read)return false;
  if(stream===config.workspace+':meta')return read || request.method==='POST';
  if(new RegExp('^'+config.workspace+':mf:[a-zA-Z0-9_-]{1,128}$').test(stream))return read;
  // Schedules: the Flock registry and one schedule's Loro doc are each created, read and appended.
  if(stream===config.workspace+':sr')return true;
  if(new RegExp('^'+config.workspace+':schedule:[a-zA-Z0-9_-]{1,128}$').test(stream))return true;
  if(new RegExp('^'+config.workspace+':s:[a-zA-Z0-9_-]{1,128}$').test(stream))return true;
  if(new RegExp('^'+config.workspace+':rpc:req:[a-zA-Z0-9_-]{1,128}$').test(stream))return request.method==='POST';
  return new RegExp('^'+config.workspace+':rpc:res:[a-zA-Z0-9_-]{1,128}:[a-zA-Z0-9_-]{1,128}$').test(stream) && (read || request.method==='PUT');
 }
 function setActive(value) {
  active=value;
  if(!active) for(const controller of requests) controller.abort();
  else {for(const wake of [...waiters]) wake();}
 }
 async function guardedFetch(input, init) {
  const original=new Request(input,init);
  if(!allowed(original)) throw Error('network_denied');
  if(!active && !['GET','HEAD'].includes(original.method))throw Error('inactive_write');
  if(!active) await new Promise((resolve,reject)=>{
   const cleanup=()=>{waiters.delete(wake);original.signal.removeEventListener('abort',abort)};
   const wake=()=>{cleanup();resolve()};const abort=()=>{cleanup();reject(Error('cancelled'))};
   if(original.signal.aborted)return abort();
   if(waiters.size>=32)return reject(Error('network_busy'));
   waiters.add(wake);original.signal.addEventListener('abort',abort,{once:true});
  });
  original.signal.throwIfAborted();
  if(requests.size>=32)throw Error('network_busy');
  const controller=new AbortController();requests.add(controller);
  const request=new Request(original,{redirect:'error',credentials:'omit',signal:AbortSignal.any([original.signal,controller.signal])});
  try {
   const response=await fetch(request);
   if(response.status===401 || response.status===403)emit({type:'networkStatus',status:'authorization_required'});
   // WebView may expose an empty stream for a null-body HTTP status.
   // Re-wrapping it with a ReadableStream makes Response throw a TypeError.
   if([204,205,304].includes(response.status)) {
    requests.delete(controller);
    await response.body?.cancel();
    return new Response(null,{status:response.status,statusText:response.statusText,headers:response.headers});
   }
   if(!response.body){requests.delete(controller);return response;}
   const reader=response.body.getReader();let bytes=0;
   const body=new ReadableStream({
    async pull(output){try {
     const part=await reader.read();
     if(part.done){requests.delete(controller);output.close();return;}
     bytes+=part.value.byteLength;if(bytes>16*1024*1024)throw Error('response_too_large');
     output.enqueue(part.value);
    }catch(error){requests.delete(controller);controller.abort();void reader.cancel().catch(()=>{});output.error(error);}},
    cancel(){requests.delete(controller);controller.abort();return reader.cancel();}
   });
   return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  } catch(error) {
   requests.delete(controller);
   // Closing a session or suspending the app cancels its request, not the network.
   if(!request.signal.aborted)emit({type:'networkStatus',status:'unavailable'});
   throw error;
  }
 }
 return {configure,setActive,fetch:guardedFetch};
}
