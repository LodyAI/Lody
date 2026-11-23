// Optional immutable distribution provenance. Never trust inherited runtime env.
declare const __LODY_DESKTOP_BUILD_JSON__: string | null;

export function getDesktopBuildDescription(): string | null {
  return typeof __LODY_DESKTOP_BUILD_JSON__ === 'string' ? __LODY_DESKTOP_BUILD_JSON__ : null;
}
