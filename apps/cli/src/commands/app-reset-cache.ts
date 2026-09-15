import { Command } from 'commander';
import {
  clearDesktopLocalResetRequest,
  getDesktopLocalResetRequestPath,
  writeDesktopLocalResetRequest,
  type DesktopLocalResetMode,
} from '@lody/shared/node/desktop-local-reset';
import { printJson, runOneShotCommand, type CommonCommandOptions } from '@/lib/command-runtime';
import { getCliPlatformKind } from '@/lib/cli-platform';
import { getLogger } from '@/utils/logger';

type AppResetCacheCommandOptions = Pick<CommonCommandOptions, 'json' | 'debug'> & {
  hard?: boolean;
  cancel?: boolean;
};

export type AppResetCacheAction = { type: 'cancel' } | { type: 'arm'; mode: DesktopLocalResetMode };

/**
 * The two levels are destructive to different degrees and `--cancel` is how a
 * mistaken `--hard` is taken back, so a run that asks for both is refused rather
 * than resolved to one of them.
 */
export function resolveAppResetCacheAction(options: {
  hard?: boolean;
  cancel?: boolean;
}): AppResetCacheAction {
  if (options.cancel) {
    if (options.hard) throw new Error('Pass either --cancel or --hard, not both.');
    return { type: 'cancel' };
  }
  return { type: 'arm', mode: options.hard ? 'hard' : 'cache' };
}

export const appResetCacheCommand = new Command('reset-cache')
  .description(
    "Clear the desktop app's local cache on its next launch (use when its window is frozen)"
  )
  .option('--hard', 'Erase all local data and sign out instead of only the recoverable cache')
  .option('--cancel', 'Disarm a reset that has not been applied yet')
  .option('--json', 'Print JSON output')
  .option('-d, --debug', 'Enable debug output')
  .action(async (options: AppResetCacheCommandOptions) => {
    await runOneShotCommand('app-reset-cache', options, async () => {
      const logger = getLogger('app-reset-cache');
      const action = resolveAppResetCacheAction(options);

      // Each installation profile owns its own data directory, so a public
      // (local) CLI reaches the OSS desktop and a cloud CLI reaches the cloud
      // desktop. No login and no daemon on this path: the app being recovered is
      // usually the reason the user cannot reach either.
      const platform = getCliPlatformKind();
      const requestPath = getDesktopLocalResetRequestPath(platform);

      if (action.type === 'cancel') {
        const canceled = await clearDesktopLocalResetRequest({ platform });
        if (options.json) {
          printJson({ ok: true, armed: false, canceled, requestPath });
          return;
        }
        logger.success(
          canceled
            ? '✅ Canceled the pending desktop reset.'
            : 'ℹ️  No pending desktop reset to cancel.'
        );
        return;
      }

      await writeDesktopLocalResetRequest({ mode: action.mode, platform });

      if (options.json) {
        printJson({ ok: true, armed: true, mode: action.mode, requestPath });
        return;
      }

      logger.success(
        action.mode === 'hard'
          ? '✅ Armed a full local reset of the desktop app. It will sign you out and erase local settings.'
          : '✅ Armed a cache reset of the desktop app. You stay signed in and keep your settings; the local conversation replica is rebuilt on the next sync.'
      );
      logger.info('👉 Quit the Lody desktop app and open it again to apply this.');
      logger.info('   Run `lody app reset-cache --cancel` to undo it before then.');
    });
  });
