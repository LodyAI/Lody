#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_NODE_API_VERSION = 10;

export function isNodeApiVersionSupported(nodeApiVersion) {
  if (typeof nodeApiVersion !== 'string' || nodeApiVersion.trim().length === 0) {
    return false;
  }

  const parsed = Number(nodeApiVersion);
  return Number.isInteger(parsed) && parsed >= REQUIRED_NODE_API_VERSION;
}

export function isNodeSecurityVersionSupported(nodeVersion) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(nodeVersion ?? '');
  if (match === null) return false;
  const [, major, minor, patch] = match.map(Number);
  const floor = { 22: [23, 4], 24: [22, 1], 26: [12, 1] }[major];
  return floor !== undefined && (minor > floor[0] || (minor === floor[0] && patch >= floor[1]));
}

export function describeUnsupportedNodeRuntime({ nodeVersion, nodeApiVersion }) {
  if (isNodeApiVersionSupported(nodeApiVersion) && isNodeSecurityVersionSupported(nodeVersion)) {
    return undefined;
  }

  return (
    `Lody requires a security-supported Node.js runtime and Node-API ${REQUIRED_NODE_API_VERSION}. ` +
    `Use Node.js v22.23.4+ (22.x), v24.22.1+ (24.x), or v26.12.1+ (26.x) ` +
    `(current: ${nodeVersion}, Node-API ${nodeApiVersion ?? 'unknown'}).`
  );
}

export function assertNodeRuntimeSupported({
  nodeVersion = process.version,
  nodeApiVersion = process.versions.napi,
} = {}) {
  const problem = describeUnsupportedNodeRuntime({ nodeVersion, nodeApiVersion });
  if (problem === undefined) {
    return;
  }

  console.error(problem);
  process.exitCode = 1;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPoint)).href) {
  assertNodeRuntimeSupported();
}
