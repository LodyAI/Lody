/** The fixed viewer's RTC adapter preserves the existing decoder and touch wire
 * contracts. It never replays input when changing transports. */
export const simulatorViewerWebRtcScript = `
let rtcDisabled=false;
function createSimulatorSocket(url){
  if(!preferWebRtc||rtcDisabled||typeof RTCPeerConnection==='undefined')return new WebSocket(url);
  let state=0,pc,media,control,fallback,stopped=false,opened=false,frame,offset=0,command;
  const abort=new AbortController();
  const socket={
    get readyState(){return fallback?fallback.readyState:state},
    get bufferedAmount(){return fallback?fallback.bufferedAmount:(control?.bufferedAmount||0)},
    binaryType:'arraybuffer',onopen:null,onmessage:null,onclose:null,onerror:null,
    send(value){if(fallback)return fallback.send(value);if(state===1)control.send(value)},
    close(){if(stopped)return;stopped=true;state=3;abort.abort();clearTimeout(timer);rejectCommand();frame=undefined;pc?.close();fallback?.close()},
    requestControl(value,signal){
      if(fallback||state!==1)return Promise.reject(Error('RTC unavailable'));
      return new Promise((resolve,reject)=>{
        if(command||signal.aborted){reject(Error('RTC unavailable'));return}
        const cancel=()=>{if(command?.requestId===value.requestId){command=undefined;reject(Error('RTC cancelled'))}};
        command={requestId:value.requestId,resolve,reject,signal,cancel};signal.addEventListener('abort',cancel,{once:true});
        try{control.send(JSON.stringify(value))}catch{rejectCommand()}
      });
    },
    get rtc(){return !fallback&&state===1}
  };
  function rejectCommand(){if(!command)return;const c=command;command=undefined;c.signal.removeEventListener('abort',c.cancel);c.reject(Error('RTC closed'))}
  function failed(code=1000){
    if(stopped||fallback||abort.signal.aborted)return;
    rtcDisabled=true;frame=undefined;abort.abort();clearTimeout(timer);pc?.close();rejectCommand();
    if(opened){state=3;stopped=true;socket.onclose?.({code});return}
    // Nothing was sent yet: bootstrap can fall back without replaying input.
    fallback=new WebSocket(url);fallback.binaryType='arraybuffer';
    fallback.onopen=e=>socket.onopen?.(e);fallback.onmessage=e=>socket.onmessage?.(e);
    fallback.onclose=e=>socket.onclose?.(e);fallback.onerror=e=>socket.onerror?.(e);
  }
  const timer=setTimeout(()=>failed(),12000);
  const endpoint=name=>{const target=new URL(name,location.href);target.search=new URL(location.href).search;return target};
  async function read(response){if(!response.ok)throw Error('RTC signaling');const text=await response.text();if(text.length>70000)throw Error('RTC response');return JSON.parse(text)}
  void (async()=>{
    const config=await read(await fetch(endpoint('rtc-config'),{signal:abort.signal,redirect:'error'}));
    if(stopped||abort.signal.aborted)return;
    pc=new RTCPeerConnection({iceServers:config.iceServers,iceTransportPolicy:'all'});
    media=pc.createDataChannel('media',{ordered:true});control=pc.createDataChannel('control',{ordered:true});media.binaryType='arraybuffer';
    pc.onconnectionstatechange=()=>{if(['failed','disconnected'].includes(pc.connectionState))failed()};
    media.onclose=control.onclose=()=>{if(!abort.signal.aborted)failed()};
    media.onerror=control.onerror=()=>{if(!abort.signal.aborted)failed()};
    media.onmessage=e=>{
      if(stopped||state!==1)return;
      const bytes=e.data;
      if(!(bytes instanceof ArrayBuffer)||bytes.byteLength<=8||bytes.byteLength>16384){failed();return}
      const view=new DataView(bytes),total=view.getUint32(0),at=view.getUint32(4),part=new Uint8Array(bytes,8);
      if(!total||total>16*1024*1024+8||at!==offset||at+part.length>total||(frame&&frame.length!==total)){failed();return}
      if(!frame)frame=new Uint8Array(total);
      frame.set(part,at);offset+=part.length;
      if(offset===total){const data=frame.buffer;frame=undefined;offset=0;socket.onmessage?.({data})}
    };
    control.onmessage=e=>{
      if(stopped||typeof e.data!=='string'||e.data.length>4096)return;
      let message;try{message=JSON.parse(e.data)}catch{return}
      if(message.type==='rtc-ready'&&!opened){opened=true;state=1;clearTimeout(timer);socket.onopen?.({});return}
      if(message.type==='rtc-close'){failed(message.code);return}
      if(message.type==='rtc-control-result'){
        if(command?.requestId!==message.requestId)return;
        const c=command;command=undefined;c.signal.removeEventListener('abort',c.cancel);c.resolve(message);return;
      }
      if(state===1)socket.onmessage?.(e);
    };
    await pc.setLocalDescription(await pc.createOffer());
    if(pc.iceGatheringState!=='complete')await new Promise((resolve,reject)=>{
      const finish=()=>{pc.removeEventListener('icegatheringstatechange',changed);pc.removeEventListener('icecandidate',changed);abort.signal.removeEventListener('abort',cancel)};
      // A usable relay must not wait for unrelated, blocked UDP/STUN probes.
      const changed=()=>{if(pc.iceGatheringState==='complete'||/ typ relay(?: |\\r?\\n|$)/.test(pc.localDescription?.sdp||'')){finish();resolve()}};
      const cancel=()=>{finish();reject(Error('RTC cancelled'))};
      pc.addEventListener('icegatheringstatechange',changed);pc.addEventListener('icecandidate',changed);abort.signal.addEventListener('abort',cancel,{once:true});
      if(abort.signal.aborted)cancel();else changed();
    });
    if(stopped||abort.signal.aborted)return;
    const answer=await read(await fetch(endpoint('rtc'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sdp:pc.localDescription.sdp,codec:url.searchParams.get('codec')==='h264'?'h264':'mjpeg'}),signal:abort.signal,redirect:'error'}));
    if(stopped||abort.signal.aborted)return;
    await pc.setRemoteDescription({type:'answer',sdp:answer.sdp});
  })().catch(()=>{if(!abort.signal.aborted)failed()});
  return socket;
}
`;
