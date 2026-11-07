// Version this boundary when bootstrap, loading, startup custody or resource layout
// changes incompatibly. Build bytes and publication policy are not ABI inputs.
export const HOST_ABI = 'lody.core-host.v1'
export const CORE_RUNTIME_REQUIREMENTS = {
  electron: { minimum: '44.0.0', before: '45.0.0' },
  node: { minimum: '24.0.0', before: '25.0.0' },
  nodeApi: { minimum: '10.0.0', before: null }
}

function version(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    throw new Error('Invalid Host capability version')
  const parts = value.split('.').map(Number)
  if (parts.some((part) => !Number.isSafeInteger(part)))
    throw new Error('Invalid Host capability version')
  return parts
}
function compare(a, b) {
  const left = version(a),
    right = version(b)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  return 0
}
function record(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length > 256
  )
    throw new Error('Invalid Host capabilities')
  for (const key of Object.keys(value))
    if (!/^[A-Za-z0-9@][A-Za-z0-9@/._-]{0,159}$/.test(key))
      throw new Error('Invalid Host capability name')
}
export function validateCapabilities(capabilities) {
  record(capabilities)
  for (const value of Object.values(capabilities)) version(value)
}
export function validateRequirements(requirements) {
  record(requirements)
  for (const requirement of Object.values(requirements)) {
    if (!requirement || Object.keys(requirement).sort().join() !== 'before,minimum')
      throw new Error('Invalid Host requirement')
    version(requirement.minimum)
    if (requirement.before !== null && compare(requirement.minimum, requirement.before) >= 0)
      throw new Error('Invalid Host requirement interval')
  }
}
export function dependencyRequirement(value) {
  const [major, minor, patch] = version(value)
  const upper = major ? [major + 1, 0, 0] : minor ? [0, minor + 1, 0] : [0, 0, patch + 1]
  return { minimum: value, before: upper.join('.') }
}
export function assertHostCompatible(manifest, installed) {
  for (const key of ['hostAbi', 'channel', 'platform', 'arch'])
    if (manifest[key] !== installed[key]) throw new Error(`Incompatible ${key}`)
  const requirements = manifest.hostRequirements
  validateRequirements(requirements)
  const capabilities = installed.hostCapabilities ?? {}
  validateCapabilities(capabilities)
  for (const [name, requirement] of Object.entries(requirements)) {
    const provided = capabilities[name]
    if (
      !Object.hasOwn(capabilities, name) ||
      compare(provided, requirement.minimum) < 0 ||
      (requirement.before !== null && compare(provided, requirement.before) >= 0)
    )
      throw new Error(`Incompatible Host capability: ${name}`)
  }
}
