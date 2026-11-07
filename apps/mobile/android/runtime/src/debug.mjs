import {contractBridge} from './contract-bridge.mjs';
import '../vendor/cloud-runtime/src/runtime/index.ts';
import {createCommands} from './create-commands.mjs';
import { createDispatcher, HOST_PROTOCOL, CORE_CAPABILITIES } from './dispatch.mjs';
import { Flock } from '@loro-dev/flock-wasm/base64';
import { LoroDoc } from 'loro-crdt';
import { decompress } from 'fzstd';
import { encodeFrame, decodeFrames } from '../vendor/cloud-runtime/src/frames.ts';
const emit = message => globalThis.webkit.messageHandlers.dataRuntime.postMessage(message);
const runtime=contractBridge(globalThis.dataRuntime,emit);
async function compatibility() {
  const checks = [];
  const check = async (name, test) => {
    try { if (!(await test())) throw Error(); checks.push({name,passed:true}); }
    catch { checks.push({name,passed:false}); }
  };
  await check('Shared runtime + bridge', async () => await runtime.ping() === true && typeof await runtime.probeSchema() === 'object');
  await check('Flock WASM snapshot', () => {
    const a = new Flock('android-probe-a'), b = new Flock('android-probe-b');
    a.set(['m','session-probe'], {title:'Android ✓'}, 1);
    b.importFile(a.exportFile());
    return b.get(['m','session-probe'])?.title === 'Android ✓';
  });
  await check('Loro WASM framed snapshot', () => {
    const a = new LoroDoc(), b = new LoroDoc();
    try {
      a.getText('content').insert(0, 'Android 中文 ✓'); a.commit();
      const framed = encodeFrame(a.export({mode:'snapshot'}));
      b.import(decodeFrames(framed)[0]);
      return b.getText('content').toString() === 'Android 中文 ✓';
    } finally { a.free(); b.free(); }
  });
  await check('Zstd decompression', () => {
    // A Zstandard frame containing one last, raw block: "hello".
    const frame = new Uint8Array([40,181,47,253,32,5,41,0,0,104,101,108,108,111]);
    return new TextDecoder().decode(decompress(frame)) === 'hello';
  });
  await check('Web Crypto + secure origin', async () => {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));
    return isSecureContext && crypto.randomUUID().length === 36 && Array.from(new Uint8Array(hash)).map(x=>x.toString(16).padStart(2,'0')).join('') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  });
  await check('ReadableStream + UTF-8', async () => {
    const reader = new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('中文'));c.close();}}).getReader();
    return new TextDecoder().decode((await reader.read()).value) === '中文' && (await reader.read()).done;
  });
  await check('AbortSignal timeout', async () => {
    const signal = AbortSignal.timeout(10);
    await new Promise(resolve => setTimeout(resolve, 30));
    return signal.aborted;
  });
  return checks;
}
const creationFixture=createCommands({
 creationOptions:()=>({agents:[{id:'fixture-agent',name:'Fixture assistant',machineId:'fixture-machine',cliType:'builtin',agentType:'codex'}],capabilities:[]}),
 createSession:async()=>({state:'created'}),ensureSession:async()=>true,
},async args=>({state:args.text==='中文 😀'?'accepted':'not_sent'}),()=>({workspaceId:'fixture',userId:'fixture-user'}));
globalThis.androidDispatch = createDispatcher(runtime, emit, {
  ...creationFixture,
  compatibility,
  echo: value => value,
  delay: (ms, signal) => new Promise((resolve,reject)=>{const timer=setTimeout(()=>resolve(true),Math.min(ms,20000));signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('cancelled'));},{once:true});}),
  large: count => '中文😀'.repeat(count),
  event: value => {emit(value);return true;},
  stall: () => { const end=performance.now()+12000; while(performance.now()<end){}; return true; },
  // Verifies the native navigation boundary without network credentials.
  navigate: () => { location.href='https://example.invalid/escape'; return true; },
});
emit({type:'hostReady', protocol:HOST_PROTOCOL, capabilities:[...CORE_CAPABILITIES,"creationOptions","createAndSend","compatibility","echo","delay","large","event","stall","navigate"]});
