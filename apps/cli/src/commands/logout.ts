import { Command } from 'commander';
import chalk from 'chalk';
import { getLogger, rootLogger } from '../utils/logger';
import { reportError } from '../utils/telemetry';
import { AuthClient } from '@/lib/auth';
import { flushTelemetry } from '@/instrument';
import { captureAuthEvent } from './analytics-events';

interface LogoutOptions {
  debug?: boolean;
}

/**
 * 登出命令 - 清除保存的认证信息
 */
export const logoutCommand = new Command('logout')
  .description('Logout from Lody and clear saved authentication')
  .option('-d, --debug', 'enable debug output')
  .action(async (options: LogoutOptions) => {
    if (options.debug) {
      rootLogger.setDebug(true);
    }
    const logger = getLogger('logout');

    const authClient = new AuthClient(logger);
    const logoutResult = authClient.logout();
    if (!logoutResult.success) {
      captureAuthEvent('logout_failed');
      await reportError('logout', logoutResult.error, {
        message: 'Logout failed',
        logger,
      });
      await flushTelemetry();
      process.exit(1);
    }
    if (!logoutResult.user) {
      captureAuthEvent('logout_succeeded', { was_logged_in: false });
      logger.info('You are not logged in.');
      await flushTelemetry();
      return;
    }
    captureAuthEvent('logout_succeeded', { was_logged_in: true });
    // 显示当前登录的用户信息
    logger.info(`Logging out user: ${chalk.cyan(logoutResult.user.email)}`);
    logger.success('\n' + chalk.green('✓') + ' Successfully logged out!');
    await flushTelemetry();
  });
