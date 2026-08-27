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

export function describeUnsupportedNodeRuntime({ nodeVersion, nodeApiVersion }) {
  if (isNodeApiVersionSupported(nodeApiVersion)) {
    return undefined;
  }

  return (
    `Lody requires Node-API ${REQUIRED_NODE_API_VERSION} to load its SQLite binding. ` +
    `Use Node.js v22.14.0+, v23.6.0+, or a later release ` +
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
