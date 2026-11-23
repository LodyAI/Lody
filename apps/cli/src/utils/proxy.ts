import type { Agent } from 'http';
import { getLogger } from './logger';
import {
  resolveProxyAgentCore,
  resolveProxyUrlCore,
  type ProxyAgentResolution,
} from './proxy-core';

export type { ProxyAgentResolution } from './proxy-core';

const warnProxy = (message: string): void => {
  getLogger('proxy').warn(message);
};

/**
 * Get proxy agent for a given URL based on environment variables.
 * Respects HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, and NO_PROXY settings.
 *
 * @param targetUrl - The URL that will be accessed (to check against NO_PROXY)
 * @returns Proxy agent if proxy is configured and target is not in NO_PROXY, undefined otherwise
 */
export function getProxyAgent(targetUrl: string): Agent | undefined {
  return resolveProxyAgent(targetUrl).agent;
}

export function resolveProxyAgent(targetUrl: string): ProxyAgentResolution {
  return resolveProxyAgentCore(targetUrl, warnProxy);
}

export function resolveProxyUrl(targetUrl: string): Omit<ProxyAgentResolution, 'agent'> {
  return resolveProxyUrlCore(targetUrl, warnProxy);
}
