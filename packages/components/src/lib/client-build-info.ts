/** Public build constants only; never collect ambient machine or account data. */
declare const __APP_VERSION__: string;
declare const __GIT_COMMIT__: string;
declare const __BUILD_DATE__: string;
declare const __DESKTOP_RELEASE_CHANNEL__: 'stable' | 'staging' | 'nightly';
declare const __OSS_GIT_COMMIT__: string | null;

export type ClientBuildInfo = {
  appVersion?: string;
  build?: string;
  buildDate?: string;
  releaseChannel?: string;
  ossCommit?: string;
};

export function collectClientBuildInfo(): ClientBuildInfo {
  return {
    appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : undefined,
    build: typeof __GIT_COMMIT__ !== 'undefined' ? __GIT_COMMIT__ : undefined,
    buildDate: typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : undefined,
    releaseChannel:
      typeof __DESKTOP_RELEASE_CHANNEL__ !== 'undefined' ? __DESKTOP_RELEASE_CHANNEL__ : undefined,
    ossCommit:
      typeof __OSS_GIT_COMMIT__ !== 'undefined' ? (__OSS_GIT_COMMIT__ ?? undefined) : undefined,
  };
}

/** Keep sender provenance distinct from any remote machine's attached logs. */
export function appendClientBuildInfo(
  description: string,
  info: ClientBuildInfo = collectClientBuildInfo()
): string {
  const fields = [
    ['Version', info.appVersion],
    ['Channel', info.releaseChannel],
    ['Build', info.build],
    ['Open-source commit', info.ossCommit],
    ['Build date', info.buildDate],
  ];
  const lines = fields
    .filter(
      (field): field is [string, string] => typeof field[1] === 'string' && field[1].length > 0
    )
    .map(([label, value]) => `${label}: ${value}`);
  return lines.length > 0
    ? `${description}\n\n---\nReporting client build\n${lines.join('\n')}`
    : description;
}
