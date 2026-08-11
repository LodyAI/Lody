import { useEffect, useId, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Loader2, LogIn, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  AgentConfigCliType,
  AgentConfigId,
  BuiltinRuntimeOverrides,
  CustomAcpLaunchSpec,
  MachineAcpAuthenticationProgressMessage,
  MachineId,
} from '@lody/shared';

import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { useAtomValue } from 'jotai';
import { useMachineAcpAuthentication } from '@/hooks/use-machine-acp-authentication';
import { resyncMachineFlockRows } from '@/hooks/use-machine-flock-rows';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { isElectronRenderer } from '@/lib/electron';
import { openExternalUrl } from '@/lib/native-browser';
import { isNativeAppShell } from '@/lib/native-platform';
import { cn } from '@/lib/utils';

type AuthenticationPhase = 'idle' | 'running' | 'authenticated' | 'cancelled' | 'error';
export type AcpAuthorizationDetails = Pick<
  MachineAcpAuthenticationProgressMessage,
  'authorizationUrl' | 'userCode' | 'acceptsAuthorizationCode' | 'expiresInSeconds'
> & { authorizationUrl: string };

export function AcpAuthenticationPanel({
  machineId,
  configId,
  cliType,
  agentType,
  customAcp,
  runtimeOverrides,
  env,
  compact = false,
  reauthentication = false,
  onAuthenticated,
}: {
  machineId: MachineId | null;
  configId?: AgentConfigId;
  cliType: AgentConfigCliType;
  agentType: string;
  customAcp?: CustomAcpLaunchSpec;
  runtimeOverrides?: BuiltinRuntimeOverrides;
  env?: Record<string, string>;
  compact?: boolean;
  reauthentication?: boolean;
  onAuthenticated?: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const { startAuthentication, cancelAuthentication, submitAuthorizationCode } =
    useMachineAcpAuthentication(runtime, workspaceId);
  const [phase, setPhase] = useState<AuthenticationPhase>('idle');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authorization, setAuthorization] = useState<AcpAuthorizationDetails | null>(null);
  const [authorizationCode, setAuthorizationCode] = useState('');
  const [authorizationCodeSubmitted, setAuthorizationCodeSubmitted] = useState(false);
  const [submittingAuthorizationCode, setSubmittingAuthorizationCode] = useState(false);
  const [userCodeCopied, setUserCodeCopied] = useState(false);
  const pendingAuthorizationWindowRef = useRef<Window | null>(null);
  const openedAuthorizationUrlRef = useRef<string | null>(null);
  const provider = getAcpAuthenticationAccountName(agentType);

  const authArgs = machineId
    ? { machineId, configId, cliType, agentType, customAcp, runtimeOverrides, env }
    : null;

  const closePendingAuthorizationWindow = (): void => {
    const pendingWindow = pendingAuthorizationWindowRef.current;
    pendingAuthorizationWindowRef.current = null;
    if (pendingWindow && !pendingWindow.closed) {
      pendingWindow.close();
    }
  };

  useEffect(
    () => () => {
      const pendingWindow = pendingAuthorizationWindowRef.current;
      pendingAuthorizationWindowRef.current = null;
      if (pendingWindow && !pendingWindow.closed) {
        pendingWindow.close();
      }
    },
    []
  );

  const openProviderAuthorization = (authorizationUrl: string): void => {
    if (openedAuthorizationUrlRef.current === authorizationUrl) return;
    openedAuthorizationUrlRef.current = authorizationUrl;
    const pendingWindow = pendingAuthorizationWindowRef.current;
    pendingAuthorizationWindowRef.current = null;
    if (pendingWindow && !pendingWindow.closed) {
      try {
        pendingWindow.location.href = authorizationUrl;
        return;
      } catch {
        pendingWindow.close();
      }
    }
    void openExternalUrl(authorizationUrl).then((opened) => {
      if (!opened) openedAuthorizationUrlRef.current = null;
    });
  };

  const handleStart = (): void => {
    if (!authArgs || phase === 'running') return;
    closePendingAuthorizationWindow();
    pendingAuthorizationWindowRef.current = prepareAuthorizationWindow(
      t('agents.authentication.preparingBrowser', 'Preparing {{provider}} sign-in…', { provider })
    );
    openedAuthorizationUrlRef.current = null;
    setPhase('running');
    setError(null);
    setAuthorization(null);
    setAuthorizationCode('');
    setAuthorizationCodeSubmitted(false);
    setSubmittingAuthorizationCode(false);
    setUserCodeCopied(false);
    const operation = startAuthentication({
      ...authArgs,
      onProgress: (progress) => {
        if (progress.status === 'authorization' && progress.authorizationUrl) {
          const nextAuthorization: AcpAuthorizationDetails = {
            authorizationUrl: progress.authorizationUrl,
            userCode: progress.userCode,
            acceptsAuthorizationCode: progress.acceptsAuthorizationCode,
            expiresInSeconds: progress.expiresInSeconds,
          };
          setAuthorization(nextAuthorization);
          openProviderAuthorization(progress.authorizationUrl);
        } else if (progress.status === 'cancelled') {
          closePendingAuthorizationWindow();
          setPhase('cancelled');
        } else if (progress.status === 'error') {
          closePendingAuthorizationWindow();
          setError(progress.error ?? null);
          setPhase('error');
        }
      },
    });
    setRequestId(operation.requestId);
    void operation.promise
      .then(async (response) => {
        if (response.disposition === 'authenticated') {
          if (response.capabilitiesRefreshed === false) {
            setError(
              response.error ??
                (response.authRequired
                  ? t('agents.authentication.failed', 'Authentication failed')
                  : t('agents.acpCapabilities.refreshError', 'Refresh failed'))
            );
            closePendingAuthorizationWindow();
            setPhase(response.authRequired ? 'error' : 'authenticated');
            return;
          }
          closePendingAuthorizationWindow();
          setPhase('authenticated');
          await resyncMachineFlockRows(runtime, machineId).catch(() => undefined);
          await onAuthenticated?.();
        } else if (response.disposition === 'cancelled') {
          closePendingAuthorizationWindow();
          setPhase('cancelled');
        } else {
          closePendingAuthorizationWindow();
          setError(t('agents.authentication.failed', 'Authentication failed'));
          setPhase('error');
        }
      })
      .catch((nextError: unknown) => {
        closePendingAuthorizationWindow();
        setError(nextError instanceof Error ? nextError.message : String(nextError));
        setPhase('error');
      })
      .finally(() => setRequestId(null));
  };

  const handleCancel = (): void => {
    if (!authArgs || !requestId) return;
    closePendingAuthorizationWindow();
    cancelAuthentication({ ...authArgs, requestId });
  };

  const handleOpenAuthorization = async (): Promise<void> => {
    if (!authorization) return;
    const opened = await openExternalUrl(authorization.authorizationUrl);
    if (!opened) {
      setError(
        t(
          'agents.authentication.browserOpenFailed',
          'Could not open the authorization page. Check your browser settings and try again.'
        )
      );
    }
  };

  const handleCopyUserCode = async (): Promise<void> => {
    if (!authorization?.userCode) return;
    try {
      await navigator.clipboard.writeText(authorization.userCode);
      setUserCodeCopied(true);
    } catch {
      setError(t('agents.authentication.copyCodeFailed', 'Could not copy the code.'));
    }
  };

  const handleSubmitAuthorizationCode = async (): Promise<void> => {
    if (!authArgs || !requestId || !authorizationCode.trim()) return;
    setSubmittingAuthorizationCode(true);
    setError(null);
    try {
      await submitAuthorizationCode({
        ...authArgs,
        authenticationRequestId: requestId,
        authorizationCode: authorizationCode.trim(),
      });
      setAuthorizationCodeSubmitted(true);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSubmittingAuthorizationCode(false);
    }
  };

  return (
    <div className={cn('flex min-w-0 flex-col gap-2', !compact && 'rounded-lg border p-3')}>
      <div className="flex flex-wrap items-center gap-2">
        {phase === 'running' ? (
          <>
            <Button type="button" size="sm" variant="outline" disabled>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('agents.authentication.waiting', 'Waiting for {{provider}} sign-in', {
                provider,
              })}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={handleCancel}>
              <Square className="h-3.5 w-3.5" />
              {t('common.cancel', 'Cancel')}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!authArgs}
            onClick={handleStart}
          >
            <LogIn className="h-3.5 w-3.5" />
            {phase === 'error' || phase === 'cancelled'
              ? t('agents.authentication.retry', 'Retry {{provider}} sign-in', { provider })
              : phase === 'authenticated' || reauthentication
                ? t('agents.authentication.signInAgain', 'Sign in again')
                : t('agents.authentication.signIn', 'Sign in with {{provider}}', { provider })}
          </Button>
        )}
        {phase === 'authenticated' ? (
          <span className="text-xs text-primary">
            {t('agents.authentication.succeeded', '{{provider}} sign-in completed', {
              provider,
            })}
          </span>
        ) : null}
      </div>
      {phase === 'running' && authorization ? (
        <AcpAuthenticationAuthorizationView
          provider={provider}
          authorization={authorization}
          authorizationCode={authorizationCode}
          authorizationCodeSubmitted={authorizationCodeSubmitted}
          submittingAuthorizationCode={submittingAuthorizationCode}
          userCodeCopied={userCodeCopied}
          onOpenAuthorization={() => void handleOpenAuthorization()}
          onCopyUserCode={() => void handleCopyUserCode()}
          onAuthorizationCodeChange={setAuthorizationCode}
          onSubmitAuthorizationCode={() => void handleSubmitAuthorizationCode()}
        />
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export function AcpAuthenticationAuthorizationView({
  provider,
  authorization,
  authorizationCode,
  authorizationCodeSubmitted,
  submittingAuthorizationCode,
  userCodeCopied,
  onOpenAuthorization,
  onCopyUserCode,
  onAuthorizationCodeChange,
  onSubmitAuthorizationCode,
}: {
  provider: string;
  authorization: AcpAuthorizationDetails;
  authorizationCode: string;
  authorizationCodeSubmitted: boolean;
  submittingAuthorizationCode: boolean;
  userCodeCopied: boolean;
  onOpenAuthorization: () => void;
  onCopyUserCode: () => void;
  onAuthorizationCodeChange: (value: string) => void;
  onSubmitAuthorizationCode: () => void;
}) {
  const { t } = useTranslation();
  const authorizationCodeInputId = useId();
  const expiryMinutes = authorization.expiresInSeconds
    ? Math.ceil(authorization.expiresInSeconds / 60)
    : null;

  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {t('agents.authentication.finishInBrowser', 'Finish signing in to {{provider}}', {
              provider,
            })}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(
              'agents.authentication.browserOpened',
              'Complete authorization in the browser window, then return to Lody.'
            )}
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onOpenAuthorization}>
          <ExternalLink className="h-3.5 w-3.5" />
          {t('agents.authentication.openAuthorization', 'Open authorization page')}
        </Button>
      </div>

      {authorization.userCode ? (
        <div className="mt-3 rounded-md border bg-background px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t('agents.authentication.oneTimeCode', 'One-time code')}
              </p>
              <code className="mt-1 block select-all font-mono text-base font-semibold tracking-[0.14em]">
                {authorization.userCode}
              </code>
            </div>
            <Button type="button" size="sm" variant="ghost" onClick={onCopyUserCode}>
              {userCodeCopied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {userCodeCopied
                ? t('agents.authentication.codeCopied', 'Copied')
                : t('agents.authentication.copyCode', 'Copy code')}
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {expiryMinutes
              ? t(
                  'agents.authentication.enterCodeWithExpiry',
                  'Enter this code on the authorization page. It expires in {{minutes}} minutes.',
                  { minutes: expiryMinutes }
                )
              : t('agents.authentication.enterCode', 'Enter this code on the authorization page.')}
          </p>
        </div>
      ) : null}

      {authorization.acceptsAuthorizationCode ? (
        <div className="mt-3 space-y-1.5">
          <Label htmlFor={authorizationCodeInputId} className="text-xs">
            {t('agents.authentication.authorizationCode', 'Authorization code')}
          </Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id={authorizationCodeInputId}
              value={authorizationCode}
              disabled={authorizationCodeSubmitted}
              autoComplete="one-time-code"
              spellCheck={false}
              placeholder={t(
                'agents.authentication.authorizationCodePlaceholder',
                'Paste the code from the browser'
              )}
              onChange={(event) => onAuthorizationCodeChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && authorizationCode.trim()) {
                  event.preventDefault();
                  onSubmitAuthorizationCode();
                }
              }}
            />
            <Button
              type="button"
              size="sm"
              disabled={
                authorizationCodeSubmitted ||
                submittingAuthorizationCode ||
                !authorizationCode.trim()
              }
              onClick={onSubmitAuthorizationCode}
            >
              {submittingAuthorizationCode ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : authorizationCodeSubmitted ? (
                <Check className="h-3.5 w-3.5" />
              ) : null}
              {authorizationCodeSubmitted
                ? t('agents.authentication.codeSubmitted', 'Submitted')
                : t('agents.authentication.submitCode', 'Continue')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              'agents.authentication.authorizationCodeHelp',
              'Only needed if the browser shows a code instead of returning automatically.'
            )}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function getAcpAuthenticationAccountName(agentType: string): string {
  if (agentType === 'claude') return 'Claude';
  if (agentType === 'codex') return 'ChatGPT';
  if (agentType === 'kimi') return 'Kimi';
  return agentType;
}

function prepareAuthorizationWindow(message: string): Window | null {
  if (typeof window === 'undefined' || isElectronRenderer() || isNativeAppShell()) {
    return null;
  }
  try {
    const popup = window.open('', '_blank');
    if (!popup) return null;
    popup.opener = null;
    popup.document.title = 'Lody';
    popup.document.body.textContent = message;
    popup.document.body.style.cssText =
      'margin:0;min-height:100vh;display:grid;place-items:center;font:14px system-ui;color:#555';
    return popup;
  } catch {
    return null;
  }
}
