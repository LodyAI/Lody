import type { ConvexHttpClient } from 'convex/browser';
import type { ConvexReactClient } from 'convex/react';
import {
  personalCloudHostPorts,
  type PersonalCloudHostOptions,
  type PersonalCloudCustodyAdapter,
} from '../src';

/** Compile the real composition with either caller-owned authenticated SDK client. */
export function composeSdkClients(
  options: Omit<PersonalCloudHostOptions, 'client'>,
  custody: PersonalCloudCustodyAdapter,
  http: ConvexHttpClient,
  react: ConvexReactClient
) {
  return [
    personalCloudHostPorts({ ...options, client: http }, custody),
    personalCloudHostPorts({ ...options, client: react }, custody),
  ];
}
