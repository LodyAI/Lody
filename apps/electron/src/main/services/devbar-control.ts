export type DevbarControlInput = {
  enabled: boolean
  agentAccess: boolean
}

export function initialDevbarControl(envValue: string | undefined): DevbarControlInput {
  const enabled = envValue === 'true'
  return { enabled, agentAccess: enabled }
}

export function parseDevbarControlInput(value: unknown): DevbarControlInput {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Devbar control input must be an object')
  }
  const candidate = value as Partial<DevbarControlInput>
  if (typeof candidate.enabled !== 'boolean' || typeof candidate.agentAccess !== 'boolean') {
    throw new TypeError('Devbar control flags must be booleans')
  }
  if (!candidate.enabled && candidate.agentAccess) {
    throw new TypeError('Devbar agent access requires the Devbar to be enabled')
  }
  return { enabled: candidate.enabled, agentAccess: candidate.agentAccess }
}

export function devbarRendererEntry(enabled: boolean, auxiliary: boolean): string {
  return enabled && !auxiliary ? 'devbar.html' : 'index.html'
}

export function isAllowedDevbarRequestOrigin(
  requestOrigin: string | undefined,
  hubOrigin: string,
  rendererOrigin?: string
): boolean {
  return (
    requestOrigin === undefined ||
    requestOrigin === 'null' ||
    requestOrigin === hubOrigin ||
    requestOrigin === rendererOrigin
  )
}
