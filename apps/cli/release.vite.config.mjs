import { readFileSync } from 'node:fs';
import base from './vite.config.ts';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export default async function releaseConfig(context) {
  const r = JSON.parse(readFileSync(process.env.LODY_RELEASE_CONFIG, 'utf8'));
  const target = process.env.LODY_RELEASE_TARGET;
  const config = await base(context);
  const standalone = target === 'cli';
  const profile = !standalone && r.profile.channel === 'nightly' ? r.profile : null;
  Object.assign(config.define, {
    __LODY_E2E_CLOCK_BUILD__: 'false',
    __LODY_E2E_DAEMON_LOSS__: 'false',
    __LODY_DESKTOP_BUILD_JSON__: JSON.stringify(profile ? JSON.stringify(profile) : null),
    'process.env.LODY_PLATFORM': JSON.stringify('cloud'),
    'process.env.LODY_ENV': JSON.stringify(r.env.VITE_LODY_ENV),
    ...(standalone
      ? Object.fromEntries(
          Object.entries({
            LODY_AUTH_URL: r.env.VITE_CONVEX_DEPLOY_URL,
            LODY_AUTH_SITE_URL: r.env.VITE_CONVEX_SITE_URL,
            LODY_SERVER_URL: r.env.VITE_SERVER_URL,
            SITE_URL: r.env.VITE_SITE_URL,
          }).map(([key, value]) => [`process.env.${key}`, JSON.stringify(value)])
        )
      : {}),
  });
  const id = '\0lody-release-package';
  config.resolve.alias['@/pkg'] = id;
  config.build.outDir = fileURLToPath(new URL('./dist', import.meta.url));
  config.plugins.push({
    name: 'lody-release-metadata',
    resolveId(source) {
      if (source === id) return id;
    },
    load(source) {
      if (source === id)
        return `export const name = 'lody'; export const version = ${JSON.stringify(standalone ? r.cliVersion : r.embeddedCliVersion)}; export default {name, version};`;
    },
    generateBundle() {
      if (profile)
        this.emitFile({
          type: 'asset',
          fileName: 'lody-desktop-build.json',
          source: JSON.stringify(profile) + '\n',
        });
    },
  });
  return config;
}
