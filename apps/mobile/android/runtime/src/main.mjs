import {contractBridge} from './contract-bridge.mjs';
import '../vendor/cloud-runtime/src/runtime/index.ts';
import { createDispatcher, HOST_PROTOCOL, CORE_CAPABILITIES } from './dispatch.mjs';
const emit = message => globalThis.webkit.messageHandlers.dataRuntime.postMessage(message);
const runtime=contractBridge(globalThis.dataRuntime,emit);
globalThis.androidDispatch = createDispatcher(runtime, emit);
emit({type:'hostReady', protocol:HOST_PROTOCOL, capabilities:CORE_CAPABILITIES});
