import { simulatorViewerMediaScript } from './viewer-media';
/** Fixed Lody artifact, never project HTML. One JPEG decode and one pending frame at most. */
export function simulatorViewerHtml(
  operationId: string,
  initialRotation = 0,
  remote = false
): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,canvas{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#111}body{display:flex;align-items:center;justify-content:center}canvas{max-width:100%;max-height:100%;object-fit:contain;touch-action:none;display:block}</style></head><body><canvas draggable="false"></canvas><script>
'use strict';
const operationId=${JSON.stringify(operationId)};
let rotation=${JSON.stringify(initialRotation)};
const remote=${JSON.stringify(remote)};
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
let parentOrigin,visible=false,ws,pending,decoding=false,generation=0,point,pointer,wheelEnd,heartbeat,firstFrame,lastReport,painted=false,commandAbort,capturing=false;
function layout(){if(!painted)return;const swap=rotation%180!==0;const scale=Math.min((swap?innerHeight:innerWidth)/canvas.width,(swap?innerWidth:innerHeight)/canvas.height);Object.assign(canvas.style,{width:canvas.width*scale+'px',height:canvas.height*scale+'px',maxWidth:'none',maxHeight:'none',flexShrink:'0',transform:'rotate('+rotation+'deg)'})}
function report(state){const swap=rotation%180!==0,width=swap?canvas.height:canvas.width,height=swap?canvas.width:canvas.height;const key=state+':'+width+':'+height+':'+rotation;if(parentOrigin&&key!==lastReport){lastReport=key;parent.postMessage({type:'lody:ios-simulator:state',operationId,state,width,height,rotation},parentOrigin)}}
function send(value){if(ws?.readyState===1){if(ws.bufferedAmount>65536){const old=ws;ws=undefined;old.close();close();report('error');return}ws.send(JSON.stringify(value))}}
function lift(){clearTimeout(wheelEnd);flushMove();if(point){const up={...point,type:'touch1-up'};point=undefined;pointer=undefined;send(up)}}
function close(){lift();generation++;painted=false;commandAbort?.abort();clearInterval(heartbeat);clearTimeout(firstFrame);pending=undefined;if(ws){const old=ws;ws=undefined;old.close()}closeMedia();report('disconnected')}
${simulatorViewerMediaScript}
let exteriorRequested=false;
async function sendExterior(){
  if(exteriorRequested||!parentOrigin)return;exteriorRequested=true;
  try{
    const read=async(name,limit)=>{const url=new URL(name,location.href);url.search=new URL(location.href).search;const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(12000)});if(!response.ok||!response.body)throw Error('exterior');const reader=response.body.getReader(),chunks=[];let size=0;try{for(;;){const value=await reader.read();if(value.done)break;size+=value.value.byteLength;if(size>limit)throw Error('exterior');chunks.push(value.value)}}finally{await reader.cancel()}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}return bytes.buffer};
    const geometry=JSON.parse(new TextDecoder().decode(await read('exterior.json',65536)));
    const png=await read('bezel.png',4*1024*1024);
    parent.postMessage({type:'lody:ios-simulator:exterior',operationId,geometry,png},parentOrigin,[png]);
  }catch{/* Missing DeviceKit assets keep the simple fallback frame. */}
}
addEventListener('message',e=>{if(e.source!==parent||e.origin==='null'||!e.data||e.data.operationId!==operationId)return;const d=e.data;if(d.type==='lody:ios-simulator:init'&&!parentOrigin)parentOrigin=e.origin;if(e.origin!==parentOrigin||!['lody:ios-simulator:init','lody:ios-simulator:visibility'].includes(d.type)||typeof d.visible!=='boolean')return;visible=d.visible;if(visible){connect();void sendExterior()}else close()});
// These messages use the private preview plane. Never put text, URLs or pixels in RPC streams.
addEventListener('message',async e=>{
  if(!parentOrigin||e.source!==parent||e.origin!==parentOrigin||e.data?.operationId!==operationId)return;
  const d=e.data;
  if(!['lody:ios-simulator:control','lody:ios-simulator:capture'].includes(d.type)||typeof d.requestId!=='string'||!d.requestId.length||d.requestId.length>200)return;
  const reply=(value,transfer=[])=>parent.postMessage({type:d.type+'-result',operationId,requestId:d.requestId,...value},parentOrigin,transfer);
  const ready=()=>visible&&!document.hidden&&ws?.readyState===1&&painted;
  if(!ready()){reply(d.type==='lody:ios-simulator:control'?{success:false,error:'unavailable'}:{error:'unavailable'});return}
  if(d.type==='lody:ios-simulator:capture'){
    if(capturing){reply({error:'failed'});return}
    capturing=true;const g=generation;
    try{
      const output=document.createElement('canvas'),swap=rotation%180!==0;
      output.width=swap?canvas.height:canvas.width;output.height=swap?canvas.width:canvas.height;
      const context=output.getContext('2d');context.translate(output.width/2,output.height/2);context.rotate(rotation*Math.PI/180);context.drawImage(canvas,-canvas.width/2,-canvas.height/2);
      const blob=await new Promise(resolve=>output.toBlob(resolve,'image/png'));
      if(!blob)throw Error('capture');
      if(blob.size>16*1024*1024){reply({error:'too-large'});return}
      const data=await blob.arrayBuffer();
      if(g!==generation||!ready()){reply({error:'unavailable'});return}
      reply({mimeType:'image/png',data},[data]);
    }catch{reply({error:'failed'})}finally{capturing=false}
    return;
  }
  if(commandAbort){reply({success:false,error:'busy'});return}
  lift();const abort=new AbortController();commandAbort=abort;
  const timeout=setTimeout(()=>abort.abort(),12000);
  try{
    const url=new URL('control',location.href);url.search=new URL(location.href).search;
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operationId,requestId:d.requestId,control:d.control}),signal:abort.signal,redirect:'error'});
    const result=await response.json();
    if(response.ok&&result.success===true&&[0,90,180,270].includes(result.rotation)){rotation=result.rotation;layout();report('ready')}
    const error=['unavailable','unsupported','failed','busy'].includes(result.error)?result.error:'failed';
    reply(response.ok&&result.success===true?{success:true}:{success:false,error});
  }catch{reply({success:false,error:ready()?'failed':'unavailable'})}
  finally{clearTimeout(timeout);if(commandAbort===abort)commandAbort=undefined}
});
addEventListener('visibilitychange',()=>{if(document.hidden)close();else connect()});addEventListener('pagehide',close);addEventListener('blur',lift);

function position(e){const r=canvas.getBoundingClientRect(),u=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),v=Math.max(0,Math.min(1,(e.clientY-r.top)/r.height));const p=rotation===90?{x:v,y:1-u}:rotation===180?{x:1-u,y:1-v}:rotation===270?{x:1-v,y:u}:{x:u,y:v};return{x:p.x*canvas.width,y:p.y*canvas.height,width:canvas.width,height:canvas.height}}
canvas.onpointerdown=e=>{if(commandAbort||e.button!==0||pointer!==undefined||!canvas.width||ws?.readyState!==1)return;lift();pointer=e.pointerId;point=position(e);if(point.y>=point.height*.93)point.edge='bottom';canvas.setPointerCapture(pointer);send({...point,type:'touch1-down'});e.preventDefault()};canvas.onpointermove=e=>{if(pointer!==e.pointerId)return;point={...point,...position(e)};queueMove()};canvas.onpointerup=e=>{if(pointer===e.pointerId){point={...point,...position(e)};lift()}};canvas.onpointercancel=e=>{if(pointer===e.pointerId)lift()};canvas.onlostpointercapture=e=>{if(pointer===e.pointerId)lift()};
// Wheel deltas describe content scrolling; a finger moves in the opposite direction.
// Reuse the single-touch protocol, and lift before restarting at a screen boundary.
canvas.addEventListener('wheel',e=>{
  e.preventDefault();
  if(commandAbort||e.ctrlKey||pointer!==undefined||ws?.readyState!==1||!canvas.width||!canvas.height)return;
  const r=canvas.getBoundingClientRect();
  if(!r.width||!r.height||!Number.isFinite(e.deltaX)||!Number.isFinite(e.deltaY))return;
  const unit=e.deltaMode===1?16:1;
  const start=position(e),end=position({clientX:e.clientX-e.deltaX*(e.deltaMode===2?r.width:unit),clientY:e.clientY-e.deltaY*(e.deltaMode===2?r.height:unit)});
  const dx=Math.max(-canvas.width/4,Math.min(canvas.width/4,end.x-start.x));
  const dy=Math.max(-canvas.height/4,Math.min(canvas.height/4,end.y-start.y));
  if(!dx&&!dy)return;
  const minX=canvas.width*.05,maxX=canvas.width*.95,minY=canvas.height*.05,maxY=canvas.height*.95;
  if(point&&(point.x+dx<minX||point.x+dx>maxX||point.y+dy<minY||point.y+dy>maxY))lift();
  if(!point){point=position(e);point.x=Math.max(canvas.width*.3,Math.min(canvas.width*.7,point.x));point.y=Math.max(canvas.height*.3,Math.min(canvas.height*.7,point.y));send({...point,type:'touch1-down'})}
  point={...point,x:Math.max(minX,Math.min(maxX,point.x+dx)),y:Math.max(minY,Math.min(maxY,point.y+dy))};
  queueMove();clearTimeout(wheelEnd);wheelEnd=setTimeout(lift,120);
},{passive:false});
</script></body></html>`;
}
