import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Loader2, LogIn, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  machineSupportsAcpAuthenticationInteractionsProtocol,
  type AgentConfigCliType,
  type AgentConfigId,
  type BuiltinRuntimeOverrides,
  type CustomAcpLaunchSpec,
  type MachineAcpAuthenticationForm,
  type MachineAcpAuthenticationProgressMessage,
  type MachineAcpAuthMethodSummary,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';

import { getMachineMetaByIdAtomFamily } from '@/atoms/machines';
import { activeWorkspaceRuntimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { useAtomValue } from 'jotai';
import {
  useMachineAcpAuthentication,
  type MachineAcpAuthenticationArgs,
} from '@/hooks/use-machine-acp-authentication';
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
  | 'authorizationUrl'
  | 'userCode'
  | 'acceptsAuthorizationCode'
  | 'expiresInSeconds'
  | 'interactionId'
  | 'message'
  | 'requiresAuthorizationConsent'
> & { authorizationUrl: string };

export type AuthenticationInteraction =
  | { type: 'methods'; interactionId: string; methods: MachineAcpAuthMethodSummary[] }
  | {
      type: 'form';
      interactionId: string;
      message: string;
      form: MachineAcpAuthenticationForm;
    };

export function isAllowedAcpAuthorizationUrl(value: string): boolean {
  if (value.length > 8192) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

type ActivePanelAuthentication = {
  requestId: string;
  args: MachineAcpAuthenticationArgs;
  runtime: WorkspaceRuntime | null;
  workspaceId: WorkspaceId | null;
  cancel: () => void;
  submitCode: (authorizationCode: string) => Promise<void>;
  submitInput: (
    interactionId: string,
    input: {
      action: 'accept' | 'decline' | 'cancel';
      methodId?: string;
      content?: Record<string, unknown>;
    }
  ) => Promise<void>;
};

export function areAcpAuthenticationTargetsEqual(
  left: MachineAcpAuthenticationArgs,
  right: MachineAcpAuthenticationArgs
): boolean {
  return left.machineId === right.machineId && left.configId === right.configId;
}

export function AcpAuthenticationPanel({
  machineId,
  configId,
  cliType,
  agentType,
  customAcp,
  compact = false,
  reauthentication = false,
  providerName,
  onBeforeStart,
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
  /**
   * Fallback label for agents Lody has no pinned account name for. A pinned
   * provider always wins: the user signs into "ChatGPT", whatever they named
   * the config.
   */
  providerName?: string;
  /** Persist the exact Provider config that the daemon will resolve before launch. */
  onBeforeStart?: () => void | Promise<void>;
  onAuthenticated?: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const machine = useAtomValue(getMachineMetaByIdAtomFamily(machineId ?? undefined));
  const interactiveProtocolSupported =
    machineSupportsAcpAuthenticationInteractionsProtocol(machine);
  const {
    startAuthentication,
    cancelAuthentication,
    submitAuthorizationCode,
    submitAuthenticationInput,
  } = useMachineAcpAuthentication(runtime, workspaceId);
  const [phase, setPhase] = useState<AuthenticationPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [authorization, setAuthorization] = useState<AcpAuthorizationDetails | null>(null);
  const [interaction, setInteraction] = useState<AuthenticationInteraction | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [submittingInteraction, setSubmittingInteraction] = useState(false);
  const [authorizationCode, setAuthorizationCode] = useState('');
  const [authorizationCodeSubmitted, setAuthorizationCodeSubmitted] = useState(false);
  const [submittingAuthorizationCode, setSubmittingAuthorizationCode] = useState(false);
  const [userCodeCopied, setUserCodeCopied] = useState(false);
  const pendingAuthorizationWindowRef = useRef<Window | null>(null);
  const openedAuthorizationUrlRef = useRef<string | null>(null);
  const interactionIdRef = useRef<string | null>(null);
  const activeAuthenticationRef = useRef<ActivePanelAuthentication | null>(null);
  const provider =
    getAcpAuthenticationAccountName(agentType) ?? (providerName?.trim() || agentType);

  const authArgs: MachineAcpAuthenticationArgs | null = useMemo(
    () =>
      machineId && configId && (cliType !== 'custom' || customAcp) ? { machineId, configId } : null,
    [cliType, configId, customAcp, machineId]
  );

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

  useEffect(() => {
    const active = activeAuthenticationRef.current;
    if (
      !active ||
      (active.runtime === runtime &&
        active.workspaceId === workspaceId &&
        authArgs &&
        areAcpAuthenticationTargetsEqual(active.args, authArgs))
    ) {
      return;
    }
    activeAuthenticationRef.current = null;
    try {
      active.cancel();
    } catch {
      // The previous runtime may already be disposed during a workspace switch.
    }
    const pendingWindow = pendingAuthorizationWindowRef.current;
    pendingAuthorizationWindowRef.current = null;
    if (pendingWindow && !pendingWindow.closed) pendingWindow.close();
    interactionIdRef.current = null;
    setAuthorization(null);
    setInteraction(null);
    setFormValues({});
    setSubmittingInteraction(false);
    setAuthorizationCode('');
    setAuthorizationCodeSubmitted(false);
    setSubmittingAuthorizationCode(false);
    setPhase('idle');
  }, [authArgs, runtime, workspaceId]);

  const openProviderAuthorization = async (authorizationUrl: string): Promise<boolean> => {
    if (!isAllowedAcpAuthorizationUrl(authorizationUrl)) {
      closePendingAuthorizationWindow();
      return false;
    }
    if (openedAuthorizationUrlRef.current === authorizationUrl) return true;
    openedAuthorizationUrlRef.current = authorizationUrl;
    const pendingWindow = pendingAuthorizationWindowRef.current;
    pendingAuthorizationWindowRef.current = null;
    if (pendingWindow && !pendingWindow.closed) {
      try {
        pendingWindow.location.href = authorizationUrl;
        return true;
      } catch {
        pendingWindow.close();
      }
    }
    const opened = await openExternalUrl(authorizationUrl);
    if (!opened) openedAuthorizationUrlRef.current = null;
    return opened;
  };

  const handleStart = (): void => {
    void startAuthenticationFromPersistedConfig();
  };

  const startAuthenticationFromPersistedConfig = async (): Promise<void> => {
    if (!authArgs || phase === 'running' || !interactiveProtocolSupported) {
      return;
    }
    closePendingAuthorizationWindow();
    pendingAuthorizationWindowRef.current =
      cliType === 'builtin'
        ? prepareAuthorizationWindow(
            t('agents.authentication.preparingBrowser', 'Preparing {{provider}} sign-in…', {
              provider,
            })
          )
        : null;
    openedAuthorizationUrlRef.current = null;
    setPhase('running');
    setError(null);
    setAuthorization(null);
    setInteraction(null);
    interactionIdRef.current = null;
    setFormValues({});
    setSubmittingInteraction(false);
    setAuthorizationCode('');
    setAuthorizationCodeSubmitted(false);
    setSubmittingAuthorizationCode(false);
    setUserCodeCopied(false);
    try {
      await onBeforeStart?.();
    } catch (nextError) {
      closePendingAuthorizationWindow();
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      setPhase('error');
      return;
    }
    let startedRequestId: string | null = null;
    const operation = startAuthentication({
      ...authArgs,
      onProgress: (progress) => {
        if (!startedRequestId || activeAuthenticationRef.current?.requestId !== startedRequestId) {
          return;
        }
        if (progress.status === 'authorization' && progress.authorizationUrl) {
          const nextAuthorization: AcpAuthorizationDetails = {
            authorizationUrl: progress.authorizationUrl,
            userCode: progress.userCode,
            acceptsAuthorizationCode: progress.acceptsAuthorizationCode,
            expiresInSeconds: progress.expiresInSeconds,
            interactionId: progress.interactionId,
            message: progress.message,
            requiresAuthorizationConsent: progress.requiresAuthorizationConsent,
          };
          setSubmittingInteraction(false);
          setAuthorization(nextAuthorization);
          setInteraction(null);
          interactionIdRef.current = progress.requiresAuthorizationConsent
            ? (progress.interactionId ?? null)
            : null;
          setFormValues({});
          if (!progress.requiresAuthorizationConsent) {
            void openProviderAuthorization(progress.authorizationUrl).then((opened) => {
              if (!opened && activeAuthenticationRef.current?.requestId === startedRequestId) {
                setError(
                  t(
                    'agents.authentication.browserOpenFailed',
                    'Could not open the authorization page. Check your browser settings and try again.'
                  )
                );
              }
            });
          }
        } else if (
          progress.status === 'auth-methods' &&
          progress.interactionId &&
          progress.authMethods
        ) {
          setSubmittingInteraction(false);
          interactionIdRef.current = progress.interactionId;
          setInteraction({
            type: 'methods',
            interactionId: progress.interactionId,
            methods: progress.authMethods,
          });
          setAuthorization(null);
        } else if (
          progress.status === 'input-required' &&
          progress.interactionId &&
          progress.form
        ) {
          setSubmittingInteraction(false);
          interactionIdRef.current = progress.interactionId;
          setInteraction({
            type: 'form',
            interactionId: progress.interactionId,
            message: progress.message ?? '',
            form: progress.form,
          });
          setFormValues(
            Object.fromEntries(
              progress.form.fields.flatMap((field) =>
                field.type === 'secret' || field.defaultValue === undefined
                  ? []
                  : [[field.id, field.defaultValue]]
              )
            )
          );
          setAuthorization(null);
        } else if (progress.status === 'cancelled') {
          closePendingAuthorizationWindow();
          interactionIdRef.current = null;
          setFormValues({});
          setAuthorizationCode('');
          setPhase('cancelled');
        } else if (progress.status === 'error') {
          closePendingAuthorizationWindow();
          interactionIdRef.current = null;
          setFormValues({});
          setAuthorizationCode('');
          setError(progress.error ?? null);
          setPhase('error');
        }
      },
    });
    startedRequestId = operation.requestId;
    activeAuthenticationRef.current = {
      requestId: operation.requestId,
      args: authArgs,
      runtime,
      workspaceId,
      cancel: () =>
        cancelAuthentication({
          machineId: authArgs.machineId,
          authenticationRequestId: operation.requestId,
        }),
      submitCode: (code) =>
        submitAuthorizationCode({
          machineId: authArgs.machineId,
          authenticationRequestId: operation.requestId,
          authorizationCode: code,
        }),
      submitInput: (interactionId, input) =>
        submitAuthenticationInput({
          machineId: authArgs.machineId,
          authenticationRequestId: operation.requestId,
          interactionId,
          input,
        }),
    };
    void operation.promise
      .then(async (response) => {
        if (activeAuthenticationRef.current?.requestId !== operation.requestId) return;
        if (response.disposition === 'authenticated') {
          if (response.capabilitiesRefreshed === false) {
            setError(
              response.error ??
                (response.authRequired
                  ? t('agents.authentication.failed', 'Authentication failed')
                  : t('agents.acpCapabilities.refreshError', 'Refresh failed'))
            );
            closePendingAuthorizationWindow();
            interactionIdRef.current = null;
            setFormValues({});
            setAuthorizationCode('');
            setPhase(response.authRequired ? 'error' : 'authenticated');
            return;
          }
          closePendingAuthorizationWindow();
          interactionIdRef.current = null;
          setFormValues({});
          setAuthorizationCode('');
          setPhase('authenticated');
          await resyncMachineFlockRows(runtime, machineId).catch(() => undefined);
          if (activeAuthenticationRef.current?.requestId === operation.requestId) {
            await onAuthenticated?.();
          }
        } else if (response.disposition === 'cancelled') {
          closePendingAuthorizationWindow();
          interactionIdRef.current = null;
          setFormValues({});
          setAuthorizationCode('');
          setPhase('cancelled');
        } else {
          closePendingAuthorizationWindow();
          interactionIdRef.current = null;
          setFormValues({});
          setAuthorizationCode('');
          setError(t('agents.authentication.failed', 'Authentication failed'));
          setPhase('error');
        }
      })
      .catch((nextError: unknown) => {
        if (activeAuthenticationRef.current?.requestId !== operation.requestId) return;
        closePendingAuthorizationWindow();
        interactionIdRef.current = null;
        setFormValues({});
        setAuthorizationCode('');
        setError(nextError instanceof Error ? nextError.message : String(nextError));
        setPhase('error');
      })
      .finally(() => {
        if (activeAuthenticationRef.current?.requestId !== operation.requestId) return;
        activeAuthenticationRef.current = null;
      });
  };

  const handleCancel = (): void => {
    const active = activeAuthenticationRef.current;
    if (!active) return;
    closePendingAuthorizationWindow();
    active.cancel();
  };

  const handleOpenAuthorization = async (): Promise<void> => {
    const active = activeAuthenticationRef.current;
    if (!authorization || !active) return;
    if (!isAllowedAcpAuthorizationUrl(authorization.authorizationUrl)) {
      setError(
        t(
          'agents.authentication.unsafeAuthorizationUrl',
          'The Provider returned an unsafe authorization URL. Only HTTP and HTTPS pages can be opened.'
        )
      );
      return;
    }
    if (
      authorization.requiresAuthorizationConsent &&
      authorization.interactionId &&
      interactionIdRef.current === authorization.interactionId
    ) {
      closePendingAuthorizationWindow();
      pendingAuthorizationWindowRef.current = prepareAuthorizationWindow(
        t('agents.authentication.preparingBrowser', 'Preparing {{provider}} sign-in…', {
          provider,
        })
      );
      setSubmittingInteraction(true);
      setError(null);
      try {
        await active.submitInput(authorization.interactionId, { action: 'accept' });
      } catch (nextError) {
        closePendingAuthorizationWindow();
        if (
          activeAuthenticationRef.current?.requestId === active.requestId &&
          interactionIdRef.current === authorization.interactionId
        ) {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
          setSubmittingInteraction(false);
        }
        return;
      }
      if (
        activeAuthenticationRef.current?.requestId !== active.requestId ||
        interactionIdRef.current !== authorization.interactionId
      ) {
        closePendingAuthorizationWindow();
        return;
      }
      interactionIdRef.current = null;
      setSubmittingInteraction(false);
      setAuthorization((current) => {
        if (!current || current.interactionId !== authorization.interactionId) return current;
        return {
          ...current,
          authorizationUrl: current.authorizationUrl,
          requiresAuthorizationConsent: false,
        };
      });
    }
    const opened = await openProviderAuthorization(authorization.authorizationUrl);
    if (!opened && activeAuthenticationRef.current?.requestId === active.requestId) {
      setError(
        t(
          'agents.authentication.browserOpenFailed',
          'Could not open the authorization page. Check your browser settings and try again.'
        )
      );
    }
  };

  const handleSubmitInteraction = async (
    interactionId: string,
    input: {
      action: 'accept' | 'decline' | 'cancel';
      methodId?: string;
      content?: Record<string, unknown>;
    }
  ): Promise<void> => {
    const active = activeAuthenticationRef.current;
    if (!active || interactionIdRef.current !== interactionId) return;
    setSubmittingInteraction(true);
    setError(null);
    try {
      await active.submitInput(interactionId, input);
      if (interactionIdRef.current === interactionId) {
        interactionIdRef.current = null;
        setInteraction(null);
        setFormValues({});
      }
    } catch (nextError) {
      if (
        activeAuthenticationRef.current?.requestId === active.requestId &&
        interactionIdRef.current === interactionId
      ) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    } finally {
      if (activeAuthenticationRef.current?.requestId === active.requestId) {
        setSubmittingInteraction(false);
      }
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
    const active = activeAuthenticationRef.current;
    if (!active || !authorizationCode.trim()) return;
    setSubmittingAuthorizationCode(true);
    setError(null);
    try {
      await active.submitCode(authorizationCode.trim());
      if (activeAuthenticationRef.current?.requestId === active.requestId) {
        setAuthorizationCodeSubmitted(true);
      }
    } catch (nextError) {
      if (activeAuthenticationRef.current?.requestId === active.requestId) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    } finally {
      if (activeAuthenticationRef.current?.requestId === active.requestId) {
        setSubmittingAuthorizationCode(false);
      }
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
            disabled={!authArgs || !interactiveProtocolSupported}
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
      {!interactiveProtocolSupported ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'agents.authentication.machineUpgradeRequired',
            'Update the target Machine to use interactive authentication for this Provider.'
          )}
        </p>
      ) : null}
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
          authorizationConsentPending={submittingInteraction}
        />
      ) : null}
      {phase === 'running' && interaction ? (
        <AcpAuthenticationInteractionView
          interaction={interaction}
          values={formValues}
          submitting={submittingInteraction}
          onValuesChange={setFormValues}
          onSubmit={(input) => void handleSubmitInteraction(interaction.interactionId, input)}
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
  authorizationConsentPending = false,
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
  authorizationConsentPending?: boolean;
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
            {authorization.message ??
              t(
                'agents.authentication.browserOpened',
                'Complete authorization in the browser window, then return to Lody.'
              )}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={authorizationConsentPending}
          onClick={onOpenAuthorization}
        >
          {authorizationConsentPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ExternalLink className="h-3.5 w-3.5" />
          )}
          {authorization.requiresAuthorizationConsent
            ? t('agents.authentication.authorizeAndOpen', 'Authorize and open page')
            : t('agents.authentication.openAuthorization', 'Open authorization page')}
        </Button>
      </div>

      {authorization.requiresAuthorizationConsent ? (
        <code className="mt-3 block break-all rounded border bg-background px-2 py-1.5 text-xs">
          {authorization.authorizationUrl}
        </code>
      ) : null}

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

export function AcpAuthenticationInteractionView({
  interaction,
  values,
  submitting,
  onValuesChange,
  onSubmit,
}: {
  interaction: AuthenticationInteraction;
  values: Record<string, string>;
  submitting: boolean;
  onValuesChange: (values: Record<string, string>) => void;
  onSubmit: (input: {
    action: 'accept' | 'decline' | 'cancel';
    methodId?: string;
    content?: Record<string, unknown>;
  }) => void;
}) {
  const { t } = useTranslation();
  if (interaction.type === 'methods') {
    const methods = interaction.methods.filter(
      (method): method is MachineAcpAuthMethodSummary & { id: string } =>
        method.type === 'agent' && !!method.id
    );
    return (
      <div className="space-y-2 rounded-md border bg-muted/20 p-3">
        <p className="text-sm font-medium">
          {t('agents.authentication.chooseMethod', 'Choose a sign-in method')}
        </p>
        <div className="flex flex-col gap-2">
          {methods.map((method) => (
            <Button
              key={method.id}
              type="button"
              variant="outline"
              className="h-auto justify-start px-3 py-2 text-left"
              disabled={submitting}
              onClick={() => onSubmit({ action: 'accept', methodId: method.id })}
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium">{method.name ?? method.id}</span>
                {method.description ? (
                  <span className="block text-xs font-normal text-muted-foreground">
                    {method.description}
                  </span>
                ) : null}
              </span>
            </Button>
          ))}
        </div>
      </div>
    );
  }

  const invalid = interaction.form.fields.some(
    (field) => field.required && !(values[field.id] ?? '').trim()
  );
  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div>
        <p className="text-sm font-medium">
          {interaction.form.title ??
            t('agents.authentication.additionalInformation', 'Additional information')}
        </p>
        {interaction.message || interaction.form.description ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {interaction.message || interaction.form.description}
          </p>
        ) : null}
      </div>
      {interaction.form.fields.map((field) => (
        <div key={field.id} className="space-y-1.5">
          <Label className="text-xs">
            {field.label}
            {!field.required ? ` ${t('common.optional', '(optional)')}` : ''}
          </Label>
          {field.type === 'select' ? (
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={values[field.id] ?? ''}
              disabled={submitting}
              onChange={(event) => onValuesChange({ ...values, [field.id]: event.target.value })}
            >
              <option value="" disabled={field.required}>
                {t('agents.authentication.selectOption', 'Select an option')}
              </option>
              {field.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <Input
              type={field.type === 'secret' ? 'password' : 'text'}
              value={values[field.id] ?? ''}
              disabled={submitting}
              autoComplete={field.type === 'secret' ? 'off' : undefined}
              spellCheck={false}
              onChange={(event) => onValuesChange({ ...values, [field.id]: event.target.value })}
            />
          )}
          {field.description ? (
            <p className="text-xs text-muted-foreground">{field.description}</p>
          ) : null}
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        disabled={submitting || invalid}
        onClick={() => onSubmit({ action: 'accept', content: values })}
      >
        {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {t('common.continue', 'Continue')}
      </Button>
    </div>
  );
}

function getAcpAuthenticationAccountName(agentType: string): string | undefined {
  if (agentType === 'claude') return 'Claude';
  if (agentType === 'codex') return 'ChatGPT';
  if (agentType === 'kimi') return 'Kimi';
  if (agentType === 'grok') return 'xAI';
  return undefined;
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
