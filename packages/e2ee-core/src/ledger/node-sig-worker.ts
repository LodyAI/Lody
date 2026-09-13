import { parentPort, workerData } from 'node:worker_threads';
import { verifySignature } from './crypto';

type Job = { pk: Uint8Array; msg: Uint8Array; sig: Uint8Array };

const jobs = workerData as Job[];
const ok = jobs.map((job) => verifySignature(job.pk, job.msg, job.sig));
parentPort!.postMessage(ok);
