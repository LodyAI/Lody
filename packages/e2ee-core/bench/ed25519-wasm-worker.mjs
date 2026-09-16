import { parentPort, workerData } from 'node:worker_threads';

const { wasm, jobs } = workerData;
if (!Array.isArray(jobs)) throw new Error('sig-worker-jobs');
const bytes = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);
const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
const memory = instance.exports.memory;
const verify = instance.exports.verify;
const heap = instance.exports.__heap_base.value;
const out = jobs.map((job) => {
  const buf = new Uint8Array(memory.buffer);
  buf.set(job.pk, heap);
  buf.set(job.sig, heap + 32);
  buf.set(job.msg, heap + 96);
  try {
    return verify(heap, heap + 32, heap + 96, job.msg.byteLength) === 1;
  } catch {
    return false;
  }
});
parentPort.postMessage(out);
