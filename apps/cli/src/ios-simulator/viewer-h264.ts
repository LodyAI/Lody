/** WebCodecs side of the private AVC protocol. Decode dependent frames in order;
 * coalesce only decoded VideoFrames, and close every discarded GPU resource.
 */
export const simulatorViewerH264Script = `
let h264Disabled=false,codecFallback=0,usingH264=false,videoDecoder,videoEpoch=0,videoQueue=[],videoBytes=0,videoReading=false;
let videoPending,videoDraw,videoDrawAt=0,videoPaintTimer,videoWaiting=true,videoRecovery=0,videoLastSequence=0,videoOutputs=new Map();
let videoProgressTimer,videoHealthyAt=0,videoHealthyFrames=0,videoHealthyLast=0;
let videoRecoveries=0,videoRecoveryReason=0,codecFailure=0,videoBackpressure=0;
function disposeVideo(){
  clearTimeout(videoProgressTimer);videoProgressTimer=undefined;videoHealthyAt=videoHealthyFrames=videoHealthyLast=0;
  videoEpoch++;videoQueue=[];videoBytes=0;videoReading=false;videoWaiting=true;videoOutputs.clear();
  cancelAnimationFrame(videoDraw);clearTimeout(videoPaintTimer);videoDraw=undefined;videoPaintTimer=undefined;videoPending?.frame.close();videoPending=undefined;
  if(videoDecoder){try{videoDecoder.close()}catch{}videoDecoder=undefined}
}
function ackVideo(sequence){
  if(ws?.readyState!==1)return;
  send({type:'frame-ack',sequence});lastAckSequence=Math.max(lastAckSequence,sequence);
}
function fallbackVideo(reason,detail=0){
  if(!usingH264)return;
  h264Disabled=true;codecFallback=reason;codecFailure=detail;close();connect();
}
// A burst is backpressure, not a broken reference chain. Only lack of decoded
// progress for three seconds, or the hard encoded bounds, requires a fresh IDR.
function watchVideoProgress(reset=false){
  if(reset){clearTimeout(videoProgressTimer);videoProgressTimer=undefined}
  if(videoProgressTimer!==undefined||(!videoWaiting&&!videoOutputs.size&&!videoQueue.length))return;
  const epoch=videoEpoch,g=generation;
  videoProgressTimer=setTimeout(()=>{
    videoProgressTimer=undefined;
    if(epoch===videoEpoch&&g===generation)recoverVideo(2);
  },3000);
}
function recoverVideo(reason){
  if(!usingH264)return;
  videoRecoveryReason=reason;videoRecoveries++;
  const last=videoLastSequence;disposeVideo();
  if(last)ackVideo(last);
  if(++videoRecovery>3){fallbackVideo(3,4);return}
  send({type:'keyframe-request'});watchVideoProgress();
}
function decodedVideoProgress(){
  const now=performance.now();
  if(!videoHealthyFrames||now-videoHealthyLast>1000){videoHealthyAt=now;videoHealthyFrames=0}
  videoHealthyLast=now;videoHealthyFrames++;
  // One successful picture or an idle interval must not forgive a failing decoder.
  if(videoHealthyFrames>=30&&now-videoHealthyAt>=3000)videoRecovery=0;
  watchVideoProgress(true);
}
function paintVideo(timer=false){
  cancelAnimationFrame(videoDraw);clearTimeout(videoPaintTimer);videoDraw=undefined;videoPaintTimer=undefined;const entry=videoPending;videoPending=undefined;if(!entry)return;
  const image=entry.frame;
  try{
    if(!visible||document.hidden||!usingH264)return;
    const width=image.displayWidth,height=image.displayHeight;
    if(!width||!height||width>16384||height>16384){fallbackVideo(3,2);return}
    const resized=canvas.width!==width||canvas.height!==height;
    if(resized){canvas.width=width;canvas.height=height}
    ctx.drawImage(image,0,0);
    if(timer)timerPaints++;else rafPaints++;
    paintScheduleTotal+=performance.now()-videoDrawAt;paintScheduleCount++;
    const first=!painted;painted=true;
    if(resized||first)layout();paintedFrames++;
    lastPaintAt=performance.now();clearTimeout(firstFrame);report('ready');
  }finally{image.close()}
}
async function readVideo(){
  if(videoReading)return;videoReading=true;const epoch=videoEpoch,g=generation;
  try{
    while(videoQueue.length&&epoch===videoEpoch&&g===generation){
      if(videoDecoder&&(videoDecoder.decodeQueueSize>=16||videoOutputs.size>=32)){
        videoBackpressure++;watchVideoProgress();return;
      }
      const packet=videoQueue.shift();videoBytes-=packet.data.byteLength;
      if(packet.key){
        if(videoDecoder){videoDecoder.close();videoDecoder=undefined}
        videoOutputs.clear();
        const description=new Uint8Array(packet.data,11,packet.descriptionLength);
        const config={codec:'avc1.'+[description[1],description[2],description[3]].map(n=>n.toString(16).padStart(2,'0')).join(''),
          description,optimizeForLatency:true};
        let timer;
        const supported=await Promise.race([VideoDecoder.isConfigSupported(config),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('codec')),3000)})]).finally(()=>clearTimeout(timer));
        if(epoch!==videoEpoch||g!==generation)return;
        if(!supported.supported){fallbackVideo(1);return}
        const decoder=new VideoDecoder({
          output:frame=>{
            if(epoch!==videoEpoch||g!==generation||videoDecoder!==decoder){frame.close();return}
            const entry=videoOutputs.get(frame.timestamp);videoOutputs.delete(frame.timestamp);
            if(!entry){frame.close();recoverVideo(3);return}
            decodeSamples.push(performance.now()-entry.at);if(decodeSamples.length>120)decodeSamples.shift();
            if(videoPending){videoPending.frame.close();droppedFrames++}
            videoPending={frame,sequence:entry.sequence};lastDecodeAt=performance.now();
            // Only one decoded picture is retained. RAF may pause on mobile while
            // decoder output continues: receiver credit must not wait for painting.
            ackVideo(entry.sequence);decodedVideoProgress();
            if(videoDraw===undefined){
              videoDrawAt=performance.now();videoDraw=requestAnimationFrame(()=>paintVideo());
              videoPaintTimer=setTimeout(()=>paintVideo(true),100);
            }
            void readVideo();
          },
          error:()=>{if(epoch===videoEpoch&&g===generation&&videoDecoder===decoder){decodeErrors++;recoverVideo(4)}}
        });
        decoder.ondequeue=()=>{
          if(epoch===videoEpoch&&g===generation&&videoDecoder===decoder)void readVideo();
        };
        videoDecoder=decoder;decoder.configure(config);videoWaiting=false;
      }
      if(videoWaiting||!videoDecoder){ackVideo(packet.sequence);continue}
      const timestamp=packet.sequence*16667;
      videoOutputs.set(timestamp,{sequence:packet.sequence,at:performance.now()});
      watchVideoProgress();
      videoDecoder.decode(new EncodedVideoChunk({type:packet.key?'key':'delta',timestamp,data:new Uint8Array(packet.data,11+packet.descriptionLength)}));
    }
  }catch{if(epoch===videoEpoch&&g===generation){decodeErrors++;fallbackVideo(3,3)}}
  finally{if(epoch===videoEpoch)videoReading=false}
}
function receiveVideo(data){
  if(!usingH264||data.byteLength<12||data.byteLength>2*1024*1024+4107){fallbackVideo(3,1);return}
  const h=new DataView(data),sequence=h.getUint32(4),tag=h.getUint8(8),descriptionLength=h.getUint16(9),key=tag===2;
  if(!sequence||sequence<=videoLastSequence||![2,3].includes(tag)||descriptionLength>4096||
    (key?descriptionLength<7:descriptionLength!==0)||11+descriptionLength>=data.byteLength){fallbackVideo(3,1);return}
  videoLastSequence=sequence;
  if(videoWaiting&&!key&&!videoReading){droppedFrames++;ackVideo(sequence);return}
  receivedFrames++;receivedBytes+=data.byteLength;
  if(videoQueue.length>=32||videoBytes+data.byteLength>2*1024*1024){droppedFrames++;recoverVideo(1);return}
  videoQueue.push({data,sequence,key,descriptionLength});videoBytes+=data.byteLength;void readVideo();
}
`;
