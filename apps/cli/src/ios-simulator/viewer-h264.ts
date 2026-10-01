/** WebCodecs side of the private AVC protocol. Decode dependent frames in order;
 * coalesce only decoded VideoFrames, and close every discarded GPU resource.
 */
export const simulatorViewerH264Script = `
let h264Disabled=false,codecFallback=0,usingH264=false,videoDecoder,videoEpoch=0,videoQueue=[],videoBytes=0,videoReading=false;
let videoPending,videoDraw,videoWaiting=true,videoRecovery=0,videoLastSequence=0,videoOutputs=new Map();
function disposeVideo(){
  videoEpoch++;videoQueue=[];videoBytes=0;videoReading=false;videoWaiting=true;videoOutputs.clear();
  cancelAnimationFrame(videoDraw);videoDraw=undefined;videoPending?.frame.close();videoPending=undefined;
  if(videoDecoder){try{videoDecoder.close()}catch{}videoDecoder=undefined}
}
function fallbackVideo(reason){
  if(!usingH264)return;
  h264Disabled=true;codecFallback=reason;close();connect();
}
function recoverVideo(){
  if(!usingH264)return;
  const last=videoLastSequence;disposeVideo();
  if(last)send({type:'frame-ack',sequence:last});
  send({type:'keyframe-request'});
  if(++videoRecovery>3)fallbackVideo(3);
}
function paintVideo(){
  videoDraw=undefined;const entry=videoPending;videoPending=undefined;if(!entry)return;
  const image=entry.frame;
  try{
    if(!visible||document.hidden||!usingH264)return;
    const width=image.displayWidth,height=image.displayHeight;
    if(!width||!height||width>16384||height>16384){fallbackVideo(3);return}
    const resized=canvas.width!==width||canvas.height!==height;
    if(resized){canvas.width=width;canvas.height=height}
    ctx.drawImage(image,0,0);const first=!painted;painted=true;
    if(resized||first)layout();paintedFrames++;
    send({type:'frame-ack',sequence:entry.sequence});clearTimeout(firstFrame);report('ready');
  }finally{image.close()}
}
async function readVideo(){
  if(videoReading)return;videoReading=true;const epoch=videoEpoch,g=generation;
  try{
    while(videoQueue.length&&epoch===videoEpoch&&g===generation){
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
            if(!entry){frame.close();recoverVideo();return}
            decodeSamples.push(performance.now()-entry.at);if(decodeSamples.length>120)decodeSamples.shift();
            if(videoPending){videoPending.frame.close();droppedFrames++}
            videoPending={frame,sequence:entry.sequence};
            if(videoDraw===undefined)videoDraw=requestAnimationFrame(paintVideo);
          },
          error:()=>{if(epoch===videoEpoch&&g===generation&&videoDecoder===decoder){decodeErrors++;recoverVideo()}}
        });
        videoDecoder=decoder;decoder.configure(config);videoWaiting=false;
      }
      if(videoWaiting||!videoDecoder){send({type:'frame-ack',sequence:packet.sequence});continue}
      if(videoDecoder.decodeQueueSize>=16||videoOutputs.size>=32){droppedFrames++;recoverVideo();return}
      const timestamp=packet.sequence*16667;
      videoOutputs.set(timestamp,{sequence:packet.sequence,at:performance.now()});
      videoDecoder.decode(new EncodedVideoChunk({type:packet.key?'key':'delta',timestamp,data:new Uint8Array(packet.data,11+packet.descriptionLength)}));
    }
  }catch{if(epoch===videoEpoch&&g===generation){decodeErrors++;fallbackVideo(3)}}
  finally{if(epoch===videoEpoch)videoReading=false}
}
function receiveVideo(data){
  if(!usingH264||data.byteLength<12||data.byteLength>2*1024*1024+4107){fallbackVideo(3);return}
  const h=new DataView(data),sequence=h.getUint32(4),tag=h.getUint8(8),descriptionLength=h.getUint16(9),key=tag===2;
  if(!sequence||sequence<=videoLastSequence||![2,3].includes(tag)||descriptionLength>4096||
    (key?descriptionLength<7:descriptionLength!==0)||11+descriptionLength>=data.byteLength){fallbackVideo(3);return}
  videoLastSequence=sequence;
  if(videoWaiting&&!key&&!videoReading){droppedFrames++;send({type:'frame-ack',sequence});return}
  receivedFrames++;receivedBytes+=data.byteLength;
  if(videoQueue.length>=32||videoBytes+data.byteLength>2*1024*1024){droppedFrames++;recoverVideo();return}
  videoQueue.push({data,sequence,key,descriptionLength});videoBytes+=data.byteLength;void readVideo();
}
`;
