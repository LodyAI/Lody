import type { CodeCollabFileIndexBackendFactory } from './code-collab-file-index-backend';
let claimed = false;
let installed: CodeCollabFileIndexBackendFactory | undefined;
/** Private Node boot injection only; no network or profile selection occurs here. */
export function installCodeCollabFileIndexBackendFactoryLegacy(
  factory: CodeCollabFileIndexBackendFactory
) {
  if (claimed) throw new Error('Code Collab file-index factory already installed');
  claimed = true;
  installed = factory;
  return {
    close() {
      if (installed === factory) installed = undefined;
    },
  };
}
export function getInstalledCodeCollabFileIndexBackendFactoryLegacy() {
  return installed;
}
