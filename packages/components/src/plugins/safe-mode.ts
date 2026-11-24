/** Keep recovery active if the router removes the startup query string. */
const requested = () =>
  new URLSearchParams(globalThis.location?.search).getAll('safeMode').includes('1');
let active = requested();
export function pluginSafeMode(): boolean {
  return (active ||= requested());
}
