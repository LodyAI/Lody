import { CloudCapabilityUnavailableError, type PlatformCapability } from '@lody/platform';

export interface CloudHttpPort {
  readonly authBaseUrl: string | null;
  readonly serverBaseUrl: string | null;
  readonly mintAutomationControlProof?: (
    intent: import('@lody/shared/automations').RemoteAutomationIntent,
    sessionToken: string
  ) => Promise<import('@lody/shared/automations').RemoteAutomationProof>;
}

export function getAutomationProofIssuer() {
  return installedPort?.mintAutomationControlProof;
}

let installedPort: CloudHttpPort | null = null;

export function installCloudHttpPort(port: CloudHttpPort): () => void {
  if (installedPort && installedPort !== port) {
    throw new Error('A different CloudHttpPort is already installed');
  }
  installedPort = port;
  return () => {
    if (installedPort === port) installedPort = null;
  };
}

export function requireCloudAuthBaseUrl(capability: PlatformCapability, override?: string): string {
  if (!installedPort) {
    throw new CloudCapabilityUnavailableError(capability);
  }
  const baseUrl = override ?? installedPort.authBaseUrl;
  if (!baseUrl) {
    throw new Error(`Cloud capability ${JSON.stringify(capability)} requires an auth base URL`);
  }
  return baseUrl;
}
