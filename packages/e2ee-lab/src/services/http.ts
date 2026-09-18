import { Context, Layer } from 'effect';

export type LabFetch = typeof globalThis.fetch;

export interface LabHttpShape {
  readonly fetch: LabFetch;
}

export class LabHttp extends Context.Tag('lody/e2ee-lab/LabHttp')<LabHttp, LabHttpShape>() {}

export function makeLabHttp(fetchImpl: LabFetch = globalThis.fetch.bind(globalThis)): LabHttpShape {
  return { fetch: fetchImpl };
}

export const LiveLabHttp = Layer.succeed(LabHttp, makeLabHttp());

export function TestLabHttp(fetchImpl: LabFetch): Layer.Layer<LabHttp> {
  return Layer.succeed(LabHttp, makeLabHttp(fetchImpl));
}
