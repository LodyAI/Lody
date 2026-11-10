import base from './electron.vite.config.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url))
const at = (path) => resolve(root, path)

export default async function releaseConfig() {
  const r = JSON.parse(readFileSync(process.env.LODY_RELEASE_CONFIG, 'utf8'))
  const config = await base({ command: 'build', mode: 'oss' })
  const define = Object.fromEntries(
    Object.entries({
      ...r.env,
      VITE_LODY_PLATFORM: 'cloud',
      VITE_LODY_RELEASE_CHANNEL: r.profile.channel
    }).map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)])
  )
  for (const section of ['main', 'preload', 'renderer'])
    Object.assign(config[section].define, define)
  Object.assign(config.main.define, {
    __LODY_E2E_CLOCK_BUILD__: 'false',
    __LODY_DESKTOP_BUILD_JSON__: JSON.stringify(JSON.stringify(r.profile))
  })
  Object.assign(config.renderer.define, {
    __BUILD_DATE__: JSON.stringify(r.profile.builtAt),
    __GIT_COMMIT__: JSON.stringify(r.profile.privateSha ?? r.sourceSha.slice(0, 8)),
    __APP_VERSION__: JSON.stringify(r.profile.version),
    __DESKTOP_RELEASE_CHANNEL__: JSON.stringify(r.profile.channel),
    __OSS_GIT_COMMIT__: JSON.stringify(r.profile.ossSha ?? null)
  })
  // Preserve the installed CJS entry and native/Devbar runtime package resolution.
  config.main.build.lib.formats = ['cjs']
  config.main.build.externalizeDeps.exclude = ['@lody/cli-supervisor', '@lody/shared', 'effect']
  config.main.build.externalizeDeps.include = [
    'better-sqlite3',
    '@devframes/hub-ui',
    '@devframes/json-render-ui',
    '@devframes/plugin-a11y',
    '@devframes/plugin-inspect',
    '@devframes/plugin-terminals'
  ]
  config.preload.build.lib = { entry: at('apps/electron/src/preload/index.ts'), formats: ['cjs'] }
  if (r.profile.channel === 'nightly')
    config.main.resolve = {
      alias: ['../../resources/icon.png?asset', '../../build/icon-mac.padded.png?asset'].map(
        (find) => ({ find, replacement: at('apps/electron/resources/icon-nightly.png') + '?asset' })
      )
    }
  config.main.plugins = [
    ...(config.main.plugins ?? []),
    {
      name: 'lody-release-update-config',
      writeBundle() {
        writeFileSync(
          at('apps/electron/out/main/electron-update-config.json'),
          JSON.stringify(
            {
              url: r.env.VITE_ELECTRON_UPDATE_URL.replace(/\/$/, ''),
              channel: r.env.VITE_ELECTRON_UPDATE_CHANNEL,
              releaseProfile: r.profile
            },
            null,
            2
          ) + '\n'
        )
      }
    }
  ]
  config.renderer.plugins.unshift(releaseRendererPolicy(r.csp))
  config.renderer.build.minify = 'esbuild'
  return config
}

function releaseRendererPolicy(sources) {
  return {
    name: 'lody-release-renderer-policy',
    enforce: 'pre',
    transformIndexHtml(html, context) {
      if (context.path.endsWith('/recovery.html') || context.path.endsWith('/pr-image.html'))
        return html
      if (!/<meta\b(?=[^>]*http-equiv="Content-Security-Policy")[^>]*\bcontent="[^"]*"/i.test(html))
        throw new Error('Missing renderer policy')
      return html.replace(
        /(<meta\b(?=[^>]*http-equiv="Content-Security-Policy")[^>]*\bcontent=")([^"]*)(")/i,
        (all, before, policy, after) => {
          const directives = policy
            .split(';')
            .map((s) => s.trim().split(/\s+/))
            .filter((s) => s[0])
          for (const [name, additions] of Object.entries(sources)) {
            const matches = directives.filter((d) => d[0] === name)
            if (matches.length !== 1) throw new Error('Missing or duplicate renderer directive')
            for (const source of additions)
              if (!matches[0].includes(source)) matches[0].push(source)
          }
          return before + directives.map((d) => d.join(' ')).join('; ') + ';' + after
        }
      )
    }
  }
}
