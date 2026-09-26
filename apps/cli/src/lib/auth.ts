import * as fs from 'fs';
import path from 'path';
import { getConfigPath } from '@/utils';
import chalk from 'chalk';
import ora from 'ora';
import os from 'os';
import { z } from 'zod';
import { Logger, getLogger } from '../utils/logger';
import {
  getOrCreateStableMachineIdAsync,
  LODY_AUTH_SITE_URL,
  LODY_AUTH_URL,
  SITE_APP_BASE_PATH,
  SITE_URL,
} from '@/utils/const';
import { MACHINE_PAIRING_TOKEN_PREFIX } from '@lody/shared';
import { openBrowser } from '@/utils/open-browser';
import { createAuthClient } from 'better-auth/client';
import { apiKeyClient } from '@better-auth/api-key/client';
import { deviceAuthorizationClient } from 'better-auth/client/plugins';
import { convexClient } from '@convex-dev/better-auth/client/plugins';
import { deriveConvexSiteUrl, normalizeBaseUrl } from './convex-site-url';
import { normalizeAppBasePath } from './site-app-base-path';

export interface UserInfo {
  id: string;
  name?: string | null;
  email: string;
}

export interface MachineInfo {
  machineName: string;
  machineId: string;
}

export interface AuthInfo {
  user: UserInfo;
  token: string;
  machine: MachineInfo;
}

export type ValidateTokenFailureReason =
  | 'invalid'
  | 'request_failed'
  | 'invalid_response'
  | 'network_error';

export type ValidateTokenResult =
  | {
      valid: true;
      retryable?: false;
      user: UserInfo;
      userId: string;
    }
  | {
      valid: false;
      retryable: boolean;
      reason: ValidateTokenFailureReason;
      error?: string;
      status?: number;
    };

export type LoginResult =
  | ({ success: true } & AuthInfo)
  | { success: false; error: string; retryable?: boolean };
export type LogoutResult = { success: true; user?: UserInfo } | { success: false; error: string };

const UserInfoSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

const MachineInfoSchema = z
  .object({
    machineName: z.string(),
    machineId: z.string(),
  })
  .passthrough();

const AuthInfoSchema = z
  .object({
    version: z.literal(3),
    token: z.string(),
    user: UserInfoSchema,
    machine: MachineInfoSchema,
    createdAt: z.string().optional(),
  })
  .passthrough();

const DEVICE_CLIENT_ID = 'lody-cli';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

const createDeviceAuthClient = (siteUrl: string) => {
  return createAuthClient({
    baseURL: siteUrl,
    plugins: [deviceAuthorizationClient(), apiKeyClient(), convexClient()],
  });
};

type DeviceAuthClient = ReturnType<typeof createDeviceAuthClient>;

const BetterFetchHttpErrorSchema = z
  .object({
    status: z.number(),
    statusText: z.string(),
    message: z.string().optional(),
  })
  .passthrough();

const BetterAuthDeviceErrorSchema = z
  .object({
    error: z.string(),
    error_description: z.string().optional(),
  })
  .passthrough();

const DeviceCodeResponseSchema = z
  .object({
    device_code: z.string(),
    user_code: z.string(),
    verification_uri: z.string(),
    verification_uri_complete: z.string(),
    expires_in: z.number(),
    interval: z.number(),
  })
  .passthrough();

function summarizeDeviceCodeResponse(data: unknown): string {
  const parsed = DeviceCodeResponseSchema.safeParse(data);
  if (!parsed.success) {
    return JSON.stringify(data);
  }

  const { verification_uri, verification_uri_complete, expires_in, interval } = parsed.data;
  const verificationHost = (() => {
    try {
      return new URL(verification_uri).host;
    } catch {
      return 'invalid';
    }
  })();
  const completeHost = (() => {
    try {
      return new URL(verification_uri_complete).host;
    } catch {
      return 'invalid';
    }
  })();

  return JSON.stringify({
    verificationHost,
    completeHost,
    expires_in,
    interval,
    hasDeviceCode: true,
    hasUserCode: true,
  });
}

const DeviceTokenSuccessSchema = z
  .object({
    access_token: z.string(),
    token_type: z.string().optional(),
    expires_in: z.number().optional(),
    scope: z.string().optional(),
  })
  .passthrough();

const DeviceTokenErrorSchema = z
  .object({
    error: z.string(),
    error_description: z.string().optional(),
  })
  .passthrough();

const CliApiKeyCreateResponseSchema = z
  .object({
    apiKey: z.string(),
    apiKeyId: z.string().optional(),
    apiKeyStart: z.string().nullable().optional(),
    user: UserInfoSchema.nullable().optional(),
  })
  .passthrough();

const MachinePairingExchangeResponseSchema = z
  .object({
    apiKey: z.string(),
  })
  .passthrough();

const SessionUserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readSessionUserFromResponse(response: unknown): UserInfo | null {
  if (!isRecord(response)) {
    return null;
  }

  if ('data' in response) {
    const nested = readSessionUserFromResponse(response.data);
    if (nested) {
      return nested;
    }
  }

  const user = asRecord(response.user);
  const parsed = SessionUserSchema.safeParse(user);
  if (!parsed.success) {
    return null;
  }

  return {
    id: parsed.data.id,
    email: parsed.data.email,
    name: parsed.data.name,
  };
}

const ValidateCliTokenResponseSchema = z
  .object({
    valid: z.boolean(),
    userId: z.string().optional(),
    user: SessionUserSchema.nullable().optional(),
  })
  .passthrough();

export function isRetryableTokenValidationFailure(
  validation: ValidateTokenResult
): validation is Extract<ValidateTokenResult, { valid: false }> & { retryable: true } {
  return !validation.valid && validation.retryable;
}

export function isTokenValidationUnavailable(
  validation: ValidateTokenResult
): validation is Extract<ValidateTokenResult, { valid: false }> {
  return !validation.valid && validation.reason !== 'invalid';
}

function formatUnknownError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  // undici wraps the real network failure (ECONNRESET/ETIMEDOUT/…) in
  // `error.cause`, so surface the cause chain instead of just "fetch failed".
  const parts = [`${error.name}: ${error.message}`];
  let cause: unknown = error.cause;
  for (let depth = 0; cause !== undefined && cause !== null && depth < 3; depth += 1) {
    if (cause instanceof AggregateError && cause.errors.length > 0) {
      const nested = cause.errors
        .slice(0, 3)
        .map((entry) => formatUnknownError(entry))
        .join('; ');
      parts.push(`caused by ${cause.name}: ${cause.message || 'multiple errors'} [${nested}]`);
      break;
    }
    if (cause instanceof Error) {
      const code = (cause as NodeJS.ErrnoException).code;
      parts.push(`caused by ${cause.name}${code ? ` (${code})` : ''}: ${cause.message}`);
      cause = cause.cause;
    } else {
      parts.push(`caused by ${String(cause)}`);
      break;
    }
  }
  return parts.join(' — ');
}

function isRetryableTokenValidationStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export class AuthClient {
  private serverUrl: string;
  private siteUrl: string;
  private betterAuthClient: DeviceAuthClient;

  constructor(private logger: Logger = getLogger('auth')) {
    if (!LODY_AUTH_URL) {
      throw new Error('LODY_AUTH_URL is not defined');
    }
    this.serverUrl = normalizeBaseUrl(LODY_AUTH_URL);
    this.siteUrl = normalizeBaseUrl(LODY_AUTH_SITE_URL || deriveConvexSiteUrl(this.serverUrl));
    this.betterAuthClient = createDeviceAuthClient(this.siteUrl);
  }

  getAuthInfo(): AuthInfo | null {
    return loadAuthInfo();
  }

  private async finalizeLoginFromSessionToken(options: {
    sessionToken: string;
    machineName: string;
    machineId: string;
  }): Promise<LoginResult> {
    const { sessionToken, machineName, machineId } = options;
    if (!sessionToken.trim()) {
      return { success: false, error: 'Missing session token for API key creation' };
    }

    let apiKeyRes: Response;
    try {
      apiKeyRes = await fetch(`${this.siteUrl}/api/cli/api-key/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ source: 'auto' }),
      });
    } catch (error) {
      // Network/DNS failure reaching the auth service: retryable, not a sign
      // that the session token itself is bad. Surface it as such so the caller
      // can retry startup instead of treating bootstrap as permanently failed.
      return {
        success: false,
        retryable: true,
        error: `Failed to reach the auth service while creating a CLI API key: ${formatUnknownError(error)}`,
      };
    }
    if (!apiKeyRes.ok) {
      const text = await apiKeyRes.text().catch(() => '');
      return {
        success: false,
        retryable: isRetryableTokenValidationStatus(apiKeyRes.status),
        error: `Failed to create CLI API key (HTTP ${apiKeyRes.status}): ${text || 'Unknown error'}`,
      };
    }
    const apiKeyParsed = CliApiKeyCreateResponseSchema.safeParse(
      await apiKeyRes.json().catch(() => null)
    );
    if (!apiKeyParsed.success) {
      return { success: false, error: 'Invalid API key response from server' };
    }

    const accessToken = apiKeyParsed.data.apiKey;

    // Always validate and resolve user info from server-side validation (source of truth).
    const validation = await this.validateToken(accessToken);
    const resolvedUser = validation.valid ? validation.user : (apiKeyParsed.data.user ?? null);
    const resolvedUserId = validation.valid ? validation.userId : resolvedUser?.id;
    if (!validation.valid || !resolvedUser || !resolvedUserId) {
      if (isRetryableTokenValidationFailure(validation)) {
        return {
          success: false,
          retryable: true,
          error: `Login succeeded but CLI API key validation could not reach the auth service: ${validation.error ?? 'network error'}`,
        };
      }
      return {
        success: false,
        error: 'Login succeeded but API key validation failed. Please retry `lody login`.',
      };
    }

    const authInfo = {
      token: accessToken,
      user: resolvedUser,
      machine: { machineName, machineId },
    };

    await saveAuthInfo(accessToken, authInfo.user, authInfo.machine);

    return {
      success: true,
      ...authInfo,
    };
  }

  async bootstrapFromSessionToken(sessionToken: string, machineName: string): Promise<LoginResult> {
    const machineId = await getOrCreateStableMachineIdAsync();
    return await this.finalizeLoginFromSessionToken({
      sessionToken,
      machineName,
      machineId,
    });
  }

  async loginWithApiKey(apiKey: string, machineName: string): Promise<LoginResult> {
    const accessToken = apiKey.trim();
    if (!accessToken) {
      return { success: false, error: 'Missing API key for --auth login' };
    }

    const validation = await this.validateToken(accessToken);
    if (!validation.valid || !validation.user || !validation.userId) {
      if (isRetryableTokenValidationFailure(validation)) {
        return {
          success: false,
          error: `Unable to validate API key because the auth service is unreachable: ${validation.error ?? 'network error'}`,
        };
      }
      return { success: false, error: 'Invalid API key. Generate a new key and retry.' };
    }

    const machineId = await getOrCreateStableMachineIdAsync();
    const authInfo = {
      token: accessToken,
      user: validation.user,
      machine: { machineName, machineId },
    };

    await saveAuthInfo(accessToken, authInfo.user, authInfo.machine);

    return {
      success: true,
      ...authInfo,
    };
  }

  async loginWithMachinePairingToken(
    pairingToken: string,
    machineName: string
  ): Promise<LoginResult> {
    const token = pairingToken.trim();
    if (!token.startsWith(MACHINE_PAIRING_TOKEN_PREFIX)) {
      return { success: false, error: 'Invalid or expired machine connection token.' };
    }

    const machineId = await getOrCreateStableMachineIdAsync();
    let response: Response;
    try {
      response = await fetch(`${this.siteUrl}/api/cli/machine-pairing/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, machineId, machineName }),
      });
    } catch {
      return {
        success: false,
        retryable: true,
        error: 'Unable to reach the auth service. Retry the same command.',
      };
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        success: false,
        retryable: isRetryableTokenValidationStatus(response.status),
        error:
          response.status === 400 ||
          response.status === 401 ||
          response.status === 404 ||
          response.status === 410
            ? 'This machine connection token is invalid or expired.'
            : 'Unable to connect this machine. Retry the command or create a new token.',
      };
    }

    const parsed = MachinePairingExchangeResponseSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: 'Invalid machine connection response from server.' };
    }

    const validation = await this.validateToken(parsed.data.apiKey);
    if (!validation.valid) {
      return {
        success: false,
        retryable: !validation.valid && validation.retryable,
        error: 'Unable to validate the temporary machine credential. Retry the same command.',
      };
    }

    const authInfo = {
      token: parsed.data.apiKey,
      user: validation.user,
      machine: { machineName, machineId },
    };
    await saveAuthInfo(authInfo.token, authInfo.user, authInfo.machine);
    return { success: true, ...authInfo };
  }

  async login(machineName: string): Promise<LoginResult> {
    const machineId = await getOrCreateStableMachineIdAsync();

    this.logger.debug(`[device-auth] siteUrl=${this.siteUrl} serverUrl=${this.serverUrl}`);
    const deviceCodeRes = await this.betterAuthClient.device.code({ client_id: DEVICE_CLIENT_ID });
    this.logger.debug(
      `[device-auth] response: error=${JSON.stringify(deviceCodeRes.error)} data=${summarizeDeviceCodeResponse(deviceCodeRes.data)}`
    );

    if (deviceCodeRes.error) {
      const httpError = BetterFetchHttpErrorSchema.safeParse(deviceCodeRes.error);
      if (httpError.success) {
        const suffix =
          httpError.data.status === 404
            ? ` (Better Auth is served from the Convex site URL; set LODY_AUTH_SITE_URL if needed. LODY_AUTH_URL=${this.serverUrl}, auth baseURL=${this.siteUrl})`
            : '';
        return {
          success: false,
          error: `Failed to request device code (HTTP ${httpError.data.status}): ${httpError.data.statusText}${suffix}`,
        };
      }

      const deviceError = BetterAuthDeviceErrorSchema.safeParse(deviceCodeRes.error);
      if (deviceError.success) {
        return {
          success: false,
          error: `Failed to request device code: ${
            deviceError.data.error_description || deviceError.data.error
          }`,
        };
      }

      return { success: false, error: 'Failed to request device code' };
    }

    const authDataParsed = DeviceCodeResponseSchema.safeParse(deviceCodeRes.data);
    if (!authDataParsed.success) {
      return { success: false, error: 'Invalid device code response from server' };
    }
    const authData = authDataParsed.data;

    const preferredVerificationUrl = (() => {
      try {
        const base = normalizeBaseUrl(SITE_URL);
        const normalizedAppBasePath = normalizeAppBasePath(SITE_APP_BASE_PATH);
        const url = new URL(`${base}${normalizedAppBasePath}/device`);
        url.searchParams.set('user_code', authData.user_code);
        return url.toString();
      } catch {
        return authData.verification_uri_complete;
      }
    })();

    // Step 2: 显示验证信息
    this.logger.info('\n' + chalk.yellow('='.repeat(50)));
    this.logger.info(chalk.bold('Device Authorization'));
    this.logger.info(chalk.yellow('='.repeat(50)));
    this.logger.info('\nPlease visit: ' + chalk.cyan(preferredVerificationUrl));
    try {
      this.logger.info('Attempting to open the URL in your default browser...');
      await openBrowser(preferredVerificationUrl);
    } catch (browserError) {
      this.logger.warn(
        `Could not open the browser automatically: ${
          browserError instanceof Error ? browserError.message : 'Unknown error'
        }`
      );
      this.logger.info('Please open the URL manually if it did not open automatically.');
    }
    this.logger.info(chalk.yellow('='.repeat(50)) + '\n');

    // Step 3: 轮询检查授权状态
    const spinner = ora('Waiting for authorization...').start();

    let authorized = false;
    let sessionToken = '';
    const startTime = Date.now();
    const expiresAt = startTime + authData.expires_in * 1000;
    const pollIntervalMs = authData.interval * 1000;
    this.logger.debug(
      `[device-auth] polling config: interval=${authData.interval}s (${pollIntervalMs}ms sleep) expires_in=${authData.expires_in}s deadline=${new Date(expiresAt).toISOString()}`
    );

    let pollCount = 0;
    while (!authorized && Date.now() < expiresAt) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      pollCount += 1;
      this.logger.debug(
        `[device-auth] poll #${pollCount} after ${pollIntervalMs}ms sleep (elapsed ${Math.round(
          (Date.now() - startTime) / 1000
        )}s / ${authData.expires_in}s)`
      );

      try {
        const tokenRes = await this.betterAuthClient.device.token({
          grant_type: DEVICE_GRANT_TYPE,
          device_code: authData.device_code,
          client_id: DEVICE_CLIENT_ID,
        });

        if (!tokenRes.error) {
          const parsed = DeviceTokenSuccessSchema.safeParse(tokenRes.data);
          if (!parsed.success) {
            spinner.fail('Invalid device token response');
            return { success: false, error: 'Invalid device token response from server' };
          }
          sessionToken = parsed.data.access_token;
          authorized = true;
          break;
        }

        const parsedError = DeviceTokenErrorSchema.safeParse(tokenRes.error);
        if (!parsedError.success) {
          const httpError = BetterFetchHttpErrorSchema.safeParse(tokenRes.error);
          if (httpError.success) {
            const suffix =
              httpError.data.status === 404
                ? ` (LODY_AUTH_URL=${this.serverUrl}, auth baseURL=${this.siteUrl})`
                : '';
            spinner.fail(`Authorization failed (HTTP ${httpError.data.status})`);
            return {
              success: false,
              error: `Authorization failed (HTTP ${httpError.data.status}): ${httpError.data.statusText}${suffix}`,
            };
          }

          spinner.fail('Authorization failed');
          return { success: false, error: 'Authorization failed' };
        }

        switch (parsedError.data.error) {
          case 'authorization_pending':
            break;
          case 'slow_down':
            this.logger.debug(
              '[device-auth] server returned slow_down; backing off an extra interval'
            );
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
            break;
          case 'access_denied':
            spinner.fail('Authorization was denied');
            return { success: false, error: 'Authorization denied' };
          case 'expired_token':
            spinner.fail('Authorization code expired');
            return { success: false, error: 'Authorization code expired' };
          default: {
            const message = parsedError.data.error_description || parsedError.data.error;
            spinner.fail(`Authorization failed: ${message}`);
            return { success: false, error: message };
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        spinner.fail(`Network error: ${message}`);
        this.logger.error('Device authorization polling failed', { error });
        return { success: false, error: 'Network error or server error when logging in' };
      }
    }

    if (!authorized) {
      spinner.fail('Authorization timed out');
      return { success: false, error: 'Authorization timed out' };
    }

    // Step 4: exchange Better Auth session token -> long-lived CLI API key
    const result = await this.finalizeLoginFromSessionToken({
      sessionToken,
      machineName,
      machineId,
    });
    if (!result.success) {
      spinner.fail('Failed to create CLI API key');
      return result;
    }

    spinner.succeed('Authorization successful!');
    return result;
  }

  logout(): LogoutResult {
    // 检查是否有认证信息
    const existingAuth = loadAuthInfo();
    if (!existingAuth) {
      this.logger.debug('No authentication found. You are not logged in.');
      return { success: true, user: undefined };
    }

    // 获取配置文件路径
    const configPath = getConfigPath();
    try {
      fs.unlinkSync(configPath);
    } catch (error) {
      this.logger.error('Failed to remove auth file', { error });
      return { success: false, error: 'Failed to clear authentication state' };
    }
    return { success: true, user: existingAuth.user };
  }

  clearRejectedToken(rejectedToken: string): 'cleared' | 'not_current' | 'failed' {
    const existingAuth = loadAuthInfo();
    if (!existingAuth || existingAuth.token.trim() !== rejectedToken.trim()) {
      return 'not_current';
    }

    try {
      fs.unlinkSync(getConfigPath());
      return 'cleared';
    } catch (error) {
      this.logger.error('Failed to remove rejected auth file', { error });
      return 'failed';
    }
  }

  async getSessionUserFromSessionToken(sessionToken: string): Promise<UserInfo | null> {
    const trimmedToken = sessionToken.trim();
    if (!trimmedToken) {
      return null;
    }

    try {
      const response = await fetch(`${this.siteUrl}/api/auth/get-session`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${trimmedToken}`,
        },
      });

      if (!response.ok) {
        this.logger.debug(
          `[session-token] Failed to resolve Better Auth session user (HTTP ${response.status})`
        );
        return null;
      }

      return readSessionUserFromResponse(await response.json().catch(() => null));
    } catch (error) {
      this.logger.debug(
        `[session-token] Failed to resolve Better Auth session user: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  async validateToken(token: string): Promise<ValidateTokenResult> {
    const validation = await validateExistingToken(token, this.siteUrl);
    if (!validation.valid) {
      return validation;
    }

    // Reuse local cached user profile when validating the currently saved token.
    const existingAuth = loadAuthInfo();
    if (existingAuth && existingAuth.token.trim() === token.trim()) {
      return {
        ...validation,
        user: existingAuth.user,
        userId: validation.userId ?? existingAuth.user.id,
      };
    }

    return validation;
  }
}

/**
 * 保存认证信息
 */
export async function saveAuthInfo(
  token: string,
  user: UserInfo,
  machine: { machineName: string; machineId: string }
): Promise<void> {
  const configPath = getConfigPath();
  const configDir = path.dirname(configPath);

  // 确保目录存在
  fs.mkdirSync(configDir, { recursive: true });

  // 保存认证信息
  const authData = {
    version: 3,
    token,
    user,
    machine,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(configPath, JSON.stringify(authData, null, 2));
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(configPath, 0o600);
    } catch {
      // best effort
    }
  }
}

/**
 * 读取认证信息
 */
export function loadAuthInfo(): AuthInfo | null {
  try {
    const configPath = getConfigPath();
    const data = fs.readFileSync(configPath, 'utf-8');
    const parsed = AuthInfoSchema.safeParse(JSON.parse(data));
    if (!parsed.success) {
      getLogger('auth').debug('Invalid credentials.json; please run `lody logout` + `lody login`');
      return null;
    }
    return parsed.data;
  } catch {
    getLogger('auth').debug('Failed to load auth info from disk');
    return null;
  }
}

/**
 * 验证现有的token是否仍然有效
 */
export async function validateExistingToken(
  token: string,
  siteUrl: string
): Promise<ValidateTokenResult> {
  try {
    const response = await fetch(`${siteUrl}/api/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        path: 'deviceAuth:validateCliToken',
        args: { token },
      }),
    });

    if (!response.ok) {
      const retryable = isRetryableTokenValidationStatus(response.status);
      getLogger('auth').error('CLI token validation request failed', {
        status: response.status,
        statusText: response.statusText,
        retryable,
      });
      return {
        valid: false,
        retryable,
        reason: 'request_failed',
        status: response.status,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const parsed = ValidateCliTokenResponseSchema.safeParse(
      await response.json().catch(() => null)
    );
    if (!parsed.success) {
      getLogger('auth').error('Invalid CLI token validation payload');
      return {
        valid: false,
        retryable: false,
        reason: 'invalid_response',
        error: 'Invalid CLI token validation payload',
      };
    }

    if (!parsed.data.valid) {
      return { valid: false, retryable: false, reason: 'invalid' };
    }

    if (!parsed.data.user) {
      getLogger('auth').error('CLI token validation payload is missing user data');
      return {
        valid: false,
        retryable: false,
        reason: 'invalid_response',
        error: 'CLI token validation payload is missing user data',
      };
    }

    const userId = parsed.data.userId ?? parsed.data.user.id;
    return {
      valid: true,
      userId,
      user: {
        id: parsed.data.user.id,
        email: parsed.data.user.email,
        name: parsed.data.user.name,
      },
    };
  } catch (error) {
    getLogger('auth').error(`Token validation failed: ${formatUnknownError(error)}`);
    return {
      valid: false,
      retryable: true,
      reason: 'network_error',
      error: formatUnknownError(error),
    };
  }
}

export type PerformLoginResult =
  | {
      success: true;
      token: string;
      user: UserInfo;
      machine: MachineInfo;
    }
  | { success: false; error: string };

/**
 * Perform the complete login flow including machine name prompt.
 * This function is reusable by both login and start commands.
 */
export async function performLogin(
  authClient: AuthClient,
  logger: Logger,
  options?: { machineName?: string }
): Promise<PerformLoginResult> {
  const machineNameOverride = options?.machineName?.trim();

  const machineName = machineNameOverride || os.hostname();

  logger.info('  Machine Name: ' + chalk.cyan(machineName));

  const loginResult = await authClient.login(machineName);

  if (!loginResult.success) {
    return { success: false, error: loginResult.error };
  }

  return {
    success: true,
    token: loginResult.token,
    user: loginResult.user,
    machine: loginResult.machine,
  };
}

export async function performLoginWithApiKey(
  authClient: AuthClient,
  logger: Logger,
  options: { apiKey: string; machineName?: string }
): Promise<PerformLoginResult> {
  const machineNameOverride = options.machineName?.trim();
  const machineName = machineNameOverride || os.hostname();

  logger.info('Using provided API key for non-interactive login.');
  logger.info('  Machine Name: ' + chalk.cyan(machineName));

  const loginResult = await authClient.loginWithApiKey(options.apiKey, machineName);

  if (!loginResult.success) {
    return { success: false, error: loginResult.error };
  }

  return {
    success: true,
    token: loginResult.token,
    user: loginResult.user,
    machine: loginResult.machine,
  };
}

export async function performLoginWithMachinePairingToken(
  authClient: AuthClient,
  logger: Logger,
  options: { pairingToken: string; machineName?: string }
): Promise<PerformLoginResult> {
  const machineName = options.machineName?.trim() || os.hostname();

  logger.info('Connecting this machine to Lody.');
  logger.info('  Machine Name: ' + chalk.cyan(machineName));

  const loginResult = await authClient.loginWithMachinePairingToken(
    options.pairingToken,
    machineName
  );
  if (!loginResult.success) {
    return { success: false, error: loginResult.error };
  }

  return {
    success: true,
    token: loginResult.token,
    user: loginResult.user,
    machine: loginResult.machine,
  };
}

/** True when a `--auth` credential is a one-time machine pairing token. */
export function isMachinePairingCredential(credential: string): boolean {
  return credential.trim().startsWith(MACHINE_PAIRING_TOKEN_PREFIX);
}

/**
 * Non-interactive `--auth` login shared by `start`, `login`, and
 * `daemon start`. The credential is self-describing: machine pairing tokens
 * (`lody_pair_...`) go through the one-time exchange, anything else is treated
 * as a CLI API key. Keep every `--auth` entry point on this dispatcher so a
 * pairing token pasted into any of them cannot fall into the API-key path.
 */
export async function performLoginWithAuthCredential(
  authClient: AuthClient,
  logger: Logger,
  options: { credential: string; machineName?: string }
): Promise<PerformLoginResult> {
  return isMachinePairingCredential(options.credential)
    ? performLoginWithMachinePairingToken(authClient, logger, {
        pairingToken: options.credential,
        machineName: options.machineName,
      })
    : performLoginWithApiKey(authClient, logger, {
        apiKey: options.credential,
        machineName: options.machineName,
      });
}
