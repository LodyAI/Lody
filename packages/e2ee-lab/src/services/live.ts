import { Layer } from 'effect';
import { LabClock, LiveLabClock } from './clock';
import { LabFs, LiveLabFs } from './fs';
import { LabHttp, LiveLabHttp } from './http';

/** Default Node adapters for AttackLab Promise boundaries. */
export type LabServices = LabClock | LabFs | LabHttp;

export const LiveLabLayer: Layer.Layer<LabServices> = Layer.mergeAll(
  LiveLabClock,
  LiveLabFs,
  LiveLabHttp
);
