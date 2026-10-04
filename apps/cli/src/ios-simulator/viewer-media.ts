import { simulatorViewerH264Script } from './viewer-h264';
/** Inline code for the fixed viewer. Kept separate from input/control and executed
 * by viewer.test.ts as the exact shipped artifact. No project scripts or dependencies.
 */
export const simulatorViewerMediaScript = `
let drawRequest,moveRequest,queuedMove,watchdogTimer,resizeTimer;
let retryTimer,transportRetries=0,lastMessageAt=0;
// Transport failures do not establish codec incompatibility. Retry the private
// connection twice per iframe, with fresh decoder/sequence state and no replay.
function retryVideo(){
  close();
  if(!visible||document.hidden||transportRetries>=2)return;
  const delay=++transportRetries===1?500:1500;
  report('connecting');retryTimer=setTimeout(()=>{retryTimer=undefined;connect()},delay);
}
${simulatorViewerH264Script}
function streamConfig(){
  const width=Math.max(1,Math.min(8192,Math.round(innerWidth))),height=Math.max(1,Math.min(8192,Math.round(innerHeight)));
  send({type:'stream-config',width,height,dpr:Math.max(.5,Math.min(2,devicePixelRatio||1))});
}
function scheduleDraw(){if(!decoding&&drawRequest===undefined)drawRequest=requestAnimationFrame(()=>{drawRequest=undefined;void draw()})}
async function draw(){
  if(decoding||!pending)return;
  decoding=true;const frame=pending;pending=undefined;const g=generation;
  try{
    const image=await createImageBitmap(new Blob([frame.jpeg],{type:'image/jpeg'}));
    try{
      if(g!==generation||!visible)return;
      const resized=canvas.width!==image.width||canvas.height!==image.height;
      if(resized){canvas.width=image.width;canvas.height=image.height}
      ctx.drawImage(image,0,0);const first=!painted;painted=true;
      if(resized||first)layout();
      send({type:'frame-ack',sequence:frame.sequence});clearTimeout(firstFrame);report('ready');
    }finally{image.close()}
  }catch{if(g===generation){close();report('error')}}
  finally{decoding=false;if(pending)scheduleDraw()}
}
function connect(){
  if(!visible||document.hidden||ws||retryTimer!==undefined)return;
  report('connecting');const url=new URL('stream',location.href);
  url.protocol=location.protocol==='https:'?'wss:':'ws:';
  const token=new URL(location.href).searchParams.get('__lody_preview_token');if(token)url.searchParams.set('__lody_preview_token',token);
  usingH264=!h264Disabled&&typeof VideoDecoder!=='undefined'&&typeof EncodedVideoChunk!=='undefined';
  if(usingH264)url.searchParams.set('codec','h264');
  videoLastSequence=0;videoRecovery=0;
  const socket=createSimulatorSocket(url);ws=socket;socket.binaryType='arraybuffer';
  socket.onopen=()=>{
    if(ws!==socket)return;
    streamConfig();send({type:'heartbeat'});
    heartbeat=setInterval(()=>{if(visible&&!document.hidden)send({type:'heartbeat'})},15000);
    lastMessageAt=performance.now();watchdogTimer=setInterval(()=>{
      if(usingH264&&ws===socket&&performance.now()-lastMessageAt>=8000)retryVideo();
    },2000);
  };
  firstFrame=setTimeout(()=>{if(ws===socket){if(usingH264)retryVideo();else{close();report('error')}}},20000);
  socket.onmessage=e=>{
    if(ws!==socket)return;
    lastMessageAt=performance.now();
    if(typeof e.data==='string'){
      if(e.data.length>4096)return;
      try{const message=JSON.parse(e.data);
        if(message.type==='ping'&&Number.isSafeInteger(message.id)&&message.id>0)send({type:'pong',id:message.id});
      }catch{/* Ignore malformed control messages. */}
      return;
    }
    if(!(e.data instanceof ArrayBuffer))return;
    if(e.data.byteLength<9||e.data.byteLength>16*1024*1024+8){close();report('error');return}
    const header=new DataView(e.data);
    if(header.getUint32(0)===0x4c415643){receiveVideo(e.data);return}
    if(usingH264){fallbackVideo();return}
    if(header.getUint32(0)!==0x4c4f4459||header.getUint32(4)===0){close();report('error');return}
    pending={sequence:header.getUint32(4),jpeg:new Uint8Array(e.data,8)};scheduleDraw();
  };
  socket.onclose=e=>{if(ws===socket){if(usingH264){if(e?.code===4002)fallbackVideo();else retryVideo()}else{close();report('disconnected')}}};
  socket.onerror=()=>{if(ws===socket){if(usingH264)retryVideo();else{close();report('error')}}};
}
function flushMove(){
  cancelAnimationFrame(moveRequest);moveRequest=undefined;
  if(queuedMove){send(queuedMove);queuedMove=undefined}
}
function queueMove(){
  queuedMove=touchMessage('move');if(moveRequest===undefined)moveRequest=requestAnimationFrame(flushMove);
}
function closeMedia(){
  clearTimeout(retryTimer);retryTimer=undefined;disposeVideo();
  clearInterval(watchdogTimer);clearTimeout(resizeTimer);cancelAnimationFrame(drawRequest);drawRequest=undefined;
}
addEventListener('resize',()=>{layout();clearTimeout(resizeTimer);resizeTimer=setTimeout(streamConfig,250)});
`;
