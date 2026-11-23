/** Shared by runtime parsers and plain-Node packaging hooks. No channel lists elsewhere. */
export const LODY_PROTOCOLS = Object.freeze({
  resource: 'lody',
  stable: 'ai.lody.stable',
  nightly: 'ai.lody.nightly',
  local: 'lody-oss',
});
export const SESSION_LINK_SCHEMES = Object.freeze(Object.values(LODY_PROTOCOLS));
export const INSTALLATION_LINK_SCHEMES = Object.freeze(
  SESSION_LINK_SCHEMES.filter((scheme) => scheme !== LODY_PROTOCOLS.resource)
);
