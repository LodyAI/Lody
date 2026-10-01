import { simulatorViewerH264Script } from './viewer-h264';
/** Inline code for the fixed viewer. Kept separate from input/control and executed
 * by viewer.test.ts as the exact shipped artifact. No project scripts or dependencies.
 */
export const simulatorViewerMediaScript = `
let drawRequest,moveRequest,queuedMove,statsTimer,resizeTimer,lastServer={},lastStatsAt=performance.now();
let receivedFrames=0,receivedBytes=0,paintedFrames=0,droppedFrames=0,coalescedMoves=0,decodeErrors=0;
let decodeSamples=[],sampleAt=performance.now(),sampleReceived=0,sampleBytes=0,samplePainted=0;
let latestPerformance=null,performanceHistory=[],performanceLogging=false;
${simulatorViewerH264Script}
function streamConfig(){
  const width=Math.max(1,Math.min(8192,Math.round(innerWidth))),height=Math.max(1,Math.min(8192,Math.round(innerHeight)));
  send({type:'stream-config',width,height,dpr:Math.max(.5,Math.min(2,devicePixelRatio||1))});
}
function publishPerformance(){
  const now=performance.now(),seconds=Math.max(.001,(now-sampleAt)/1000);
  const sorted=[...decodeSamples].sort((a,b)=>a-b);
  const stats={...lastServer,codecH264:usingH264?1:0,codecFallback,decoderQueue:videoOutputs.size,remote,receivedFps:(receivedFrames-sampleReceived)/seconds,
    paintedFps:(paintedFrames-samplePainted)/seconds,receivedMbps:(receivedBytes-sampleBytes)*8/seconds/1e6,
    averageFrameBytes:(receivedBytes-sampleBytes)/Math.max(1,receivedFrames-sampleReceived),
    decodeMs:decodeSamples.reduce((a,b)=>a+b,0)/Math.max(1,decodeSamples.length),
    decodeP95Ms:sorted[Math.max(0,Math.ceil(sorted.length*.95)-1)]||0,
    viewerDroppedFrames:droppedFrames,decodeErrors,coalescedMoves,width:canvas.width,height:canvas.height,
    inputBufferedBytes:ws?.bufferedAmount||0,gatewaySampleAgeMs:Math.max(0,now-lastStatsAt),connected:ws?.readyState===1,elapsedMs:now};
  sampleAt=now;sampleReceived=receivedFrames;sampleBytes=receivedBytes;samplePainted=paintedFrames;decodeSamples=[];
  latestPerformance=stats;performanceHistory.push(stats);performanceHistory=performanceHistory.filter(s=>now-s.elapsedMs<=120000).slice(-60);
  if(parentOrigin)parent.postMessage({type:'lody:ios-simulator:performance',operationId,stats},parentOrigin);
  if(performanceLogging)console.info('[Lody iOS Simulator performance]',stats);
}
// Select the simulator iframe in DevTools. Snapshots contain numbers/booleans only.
globalThis.lodySimulator=Object.freeze({stats:()=>latestPerformance&&({...latestPerformance}),
  history:()=>performanceHistory.map(s=>({...s})),setLogging:value=>{performanceLogging=value===true}});
function scheduleDraw(){if(!decoding&&drawRequest===undefined)drawRequest=requestAnimationFrame(()=>{drawRequest=undefined;void draw()})}
async function draw(){
  if(decoding||!pending)return;
  decoding=true;const frame=pending;pending=undefined;const g=generation,start=performance.now();
  try{
    const image=await createImageBitmap(new Blob([frame.jpeg],{type:'image/jpeg'}));
    try{
      if(g!==generation||!visible)return;
      const resized=canvas.width!==image.width||canvas.height!==image.height;
      if(resized){canvas.width=image.width;canvas.height=image.height}
      ctx.drawImage(image,0,0);const first=!painted;painted=true;
      if(resized||first)layout();
      paintedFrames++;decodeSamples.push(performance.now()-start);if(decodeSamples.length>120)decodeSamples.shift();
      send({type:'frame-ack',sequence:frame.sequence});clearTimeout(firstFrame);report('ready');
    }finally{image.close()}
  }catch{if(g===generation){decodeErrors++;close();report('error')}}
  finally{decoding=false;if(pending)scheduleDraw()}
}
function connect(){
  if(!visible||document.hidden||ws)return;
  report('connecting');const url=new URL('stream',location.href);
  url.protocol=location.protocol==='https:'?'wss:':'ws:';
  const token=new URL(location.href).searchParams.get('__lody_preview_token');if(token)url.searchParams.set('__lody_preview_token',token);
  usingH264=!h264Disabled&&typeof VideoDecoder!=='undefined'&&typeof EncodedVideoChunk!=='undefined';
  if(usingH264)url.searchParams.set('codec','h264');
  videoLastSequence=0;videoRecovery=0;
  const socket=new WebSocket(url);ws=socket;socket.binaryType='arraybuffer';
  socket.onopen=()=>{
    if(ws!==socket)return;
    lastServer={};sampleAt=performance.now();sampleReceived=receivedFrames;sampleBytes=receivedBytes;samplePainted=paintedFrames;decodeSamples=[];
    streamConfig();send({type:'heartbeat'});
    heartbeat=setInterval(()=>{if(visible&&!document.hidden)send({type:'heartbeat'})},15000);
    lastStatsAt=performance.now();statsTimer=setInterval(publishPerformance,2000);
  };
  firstFrame=setTimeout(()=>{if(ws===socket){if(usingH264)fallbackVideo(4);else{close();report('error')}}},20000);
  socket.onmessage=e=>{
    if(ws!==socket)return;
    if(typeof e.data==='string'){
      if(e.data.length>4096)return;
      try{const message=JSON.parse(e.data);
        if(message.type==='ping'&&Number.isSafeInteger(message.id)&&message.id>0)send({type:'pong',id:message.id});
        if(message.type==='stream-stats'){
          const stats={};for(const key of ['sourceFps','sentFps','sourceMbps','sentMbps','sentFrames','idleRefreshFrames','droppedFrames','inFlightFrames','inFlightBytes','oldestFrameMs','ackMs','ackIdleMs','rttMs','targetFps','scale','baseRttMs','deliveryMbps','pacingMbps','windowBytes','codecH264','encoderBitrate','keyframeRequests','upstreamGaps','queuedFrames','queuedBytes']){
            const value=message[key];if(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1e12)stats[key]=value;
          }lastServer=stats;lastStatsAt=performance.now();
        }
      }catch{/* Ignore malformed numeric diagnostics. */}
      return;
    }
    if(!(e.data instanceof ArrayBuffer))return;
    if(e.data.byteLength<9||e.data.byteLength>16*1024*1024+8){close();report('error');return}
    const header=new DataView(e.data);
    if(header.getUint32(0)===0x4c415643){receiveVideo(e.data);return}
    if(usingH264){fallbackVideo(2);return}
    if(header.getUint32(0)!==0x4c4f4459||header.getUint32(4)===0){close();report('error');return}
    receivedFrames++;receivedBytes+=e.data.byteLength;
    if(pending)droppedFrames++;
    pending={sequence:header.getUint32(4),jpeg:new Uint8Array(e.data,8)};scheduleDraw();
  };
  socket.onclose=()=>{if(ws===socket){if(usingH264)fallbackVideo(2);else{close();report('disconnected')}}};
  socket.onerror=()=>{if(ws===socket){if(usingH264)fallbackVideo(2);else{close();report('error')}}};
}
function flushMove(){
  cancelAnimationFrame(moveRequest);moveRequest=undefined;
  if(queuedMove){send({...queuedMove,type:'touch1-move'});queuedMove=undefined}
}
function queueMove(){
  if(queuedMove)coalescedMoves++;
  queuedMove={...point};if(moveRequest===undefined)moveRequest=requestAnimationFrame(flushMove);
}
function closeMedia(){
  disposeVideo();
  clearInterval(statsTimer);clearTimeout(resizeTimer);cancelAnimationFrame(drawRequest);drawRequest=undefined;
  publishPerformance();
}
addEventListener('resize',()=>{layout();clearTimeout(resizeTimer);resizeTimer=setTimeout(streamConfig,250)});
`;
