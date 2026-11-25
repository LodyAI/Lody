import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Check, ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  EnvImportCandidate,
  ImportSourceDescription,
  ImportSourceId,
  SorbetAuthMethodSummary,
  SorbetOnboardingCustomProtocol,
} from '@lody/shared/electron-ipc';
import {
  EASE_OUT,
  HOLD_SUCCESS_MS,
  SHAKE_DURATION_S,
  heightTransition,
  useOnboardingReducedMotion,
} from '../motion-tokens';
import { BrowserAuthButton, StatusRingOrCheck } from './browser-auth-button';
import { flatSurface } from './flat-surface.stylex';
import {
  API_KEY_PROVIDER_OPTIONS,
  ProviderBrandIcon,
  detectProviderFromApiKeyPrefix,
  maskApiKeyDisplay,
  resolveSubscriptionCardMeta,
} from './provider-brand-icon';
import {
  EMPTY_ARRIVAL_PROBE,
  useSorbetOnboardingController,
  type ConnectedModelPayload,
} from './sorbet-onboarding-controller';

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.625rem',
    width: '100%',
  },
  header: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  },
  subscriptionGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(128px, 1fr))',
    gap: '0.625rem',
  },
  moreTile: {
    appearance: 'none',
    borderWidth: 0,
    borderRadius: '12px',
    backgroundColor: 'var(--flat-fill)',
    color: 'var(--flat-ink-secondary)',
    minHeight: '4.125rem',
    paddingBlock: '0.75rem',
    paddingInline: '0.875rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.5rem',
    fontSize: '0.875rem',
    fontWeight: 500,
    cursor: 'pointer',
    transitionProperty: 'background-color, color, transform',
    transitionDuration: '140ms, 140ms, 80ms',
    ':hover': {
      backgroundColor: 'var(--flat-fill-hover)',
      color: 'var(--flat-ink)',
    },
    ':active': {
      transform: 'scale(0.98)',
    },
    ':focus-visible': {
      outline: '2px solid var(--flat-ink)',
      outlineOffset: '2px',
    },
  },
  rowStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  },
  rowLeading: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
    minWidth: 0,
  },
  rowActionText: {
    fontSize: '0.8125rem',
    fontWeight: 500,
    color: 'var(--flat-ink-secondary)',
    flexShrink: 0,
  },
  expandedBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    paddingInline: '0.9375rem',
    paddingBottom: '0.875rem',
    paddingTop: '0.125rem',
  },
  bodyText: {
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.55,
    color: 'var(--flat-ink-secondary)',
  },
  systemPromptNotice: {
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.5,
    color: 'var(--flat-ink)',
    backgroundColor: 'var(--flat-fill-hover)',
    borderRadius: '8px',
    paddingBlock: '0.4375rem',
    paddingInline: '0.625rem',
  },
  errorText: {
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.5,
    color: 'var(--flat-danger-fg)',
  },
  actionRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '0.5rem',
  },
  envList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  },
  envItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.625rem',
    paddingBlock: '0.4375rem',
    paddingInline: '0.625rem',
    borderRadius: '8px',
    backgroundColor: 'var(--flat-fill-hover)',
    cursor: 'pointer',
    fontSize: '0.8125rem',
    color: 'var(--flat-ink)',
  },
  envCheckbox: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.78rem',
  },
  checkBoxSquare: {
    width: '15px',
    height: '15px',
    borderRadius: '4px',
    backgroundColor: 'var(--flat-input-bg)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  checkBoxSquareChecked: {
    backgroundColor: 'var(--flat-primary-bg)',
    color: 'var(--flat-primary-fg)',
  },
  maskedTail: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.75rem',
    color: 'var(--flat-ink-secondary)',
  },
  keyFieldWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    borderRadius: '10px',
    backgroundColor: 'var(--flat-input-bg)',
    paddingInline: '0.6875rem',
    paddingBlock: '0.375rem',
  },
  bareInput: {
    appearance: 'none',
    borderWidth: 0,
    outline: 'none',
    backgroundColor: 'transparent',
    color: 'var(--flat-ink)',
    fontSize: '0.84375rem',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    flex: 1,
    minWidth: 0,
    paddingBlock: '0.3125rem',
    '::placeholder': {
      color: 'var(--flat-ink-tertiary)',
      fontFamily: 'inherit',
    },
  },
  providerSelectRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.5rem',
    flexWrap: 'wrap',
  },
  nativeSelect: {
    appearance: 'none',
    borderWidth: 0,
    borderRadius: '8px',
    backgroundColor: 'var(--flat-input-bg)',
    color: 'var(--flat-ink)',
    fontSize: '0.8125rem',
    fontWeight: 500,
    paddingBlock: '0.4375rem',
    paddingInline: '0.6875rem',
    cursor: 'pointer',
  },
  customFields: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  protocolPills: {
    display: 'inline-flex',
    flexWrap: 'wrap',
    gap: '0.375rem',
  },
  protocolPill: {
    appearance: 'none',
    borderWidth: 0,
    borderRadius: '8px',
    paddingBlock: '0.375rem',
    paddingInline: '0.625rem',
    fontSize: '0.75rem',
    fontWeight: 500,
    backgroundColor: 'var(--flat-input-bg)',
    color: 'var(--flat-ink-secondary)',
    cursor: 'pointer',
    transitionProperty: 'background-color, color',
    transitionDuration: '120ms',
  },
  protocolPillActive: {
    backgroundColor: 'var(--flat-primary-bg)',
    color: 'var(--flat-primary-fg)',
  },
  footerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingTop: '0.25rem',
  },
  successInline: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4375rem',
    color: 'var(--flat-ok-fg)',
    fontSize: '0.8125rem',
    fontWeight: 500,
  },
});

const IMPORT_ROWS: ReadonlyArray<{ id: ImportSourceId; label: string }> = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'env', label: '__env__' },
];

export function ConnectModelSheet({
  showHeader = true,
  chipLayoutId,
  onConnected,
  onSkip,
  skipLabel,
}: {
  showHeader?: boolean;
  /** Shared `layoutId` target for `OnboardingChipRail` flight. */
  chipLayoutId?: string;
  onConnected?: (payload: ConnectedModelPayload) => void;
  onSkip?: () => void;
  skipLabel?: string;
}) {
  const { t } = useTranslation();
  const reducedMotion = useOnboardingReducedMotion();
  const controller = useSorbetOnboardingController();
  const probe = controller.probe ?? EMPTY_ARRIVAL_PROBE;

  const oauthMethods = useMemo<SorbetAuthMethodSummary[]>(() => {
    const list = probe.methods.filter((item) => item.type === 'oauth');
    return list.length > 0 ? list : EMPTY_ARRIVAL_PROBE.methods;
  }, [probe.methods]);

  const [showAllOAuth, setShowAllOAuth] = useState(false);
  const visibleOAuthMethods = useMemo(() => {
    if (showAllOAuth || oauthMethods.length <= 3) return oauthMethods;
    return oauthMethods.slice(0, 3);
  }, [oauthMethods, showAllOAuth]);

  // Import state — zero upfront detection; only populated when user clicks a row.
  const [expandedImport, setExpandedImport] = useState<ImportSourceId | null>(null);
  const [importDescription, setImportDescription] = useState<ImportSourceDescription | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importSuccessSource, setImportSuccessSource] = useState<ImportSourceId | null>(null);
  const [envCandidates, setEnvCandidates] = useState<EnvImportCandidate[] | null>(null);
  const [selectedEnvNames, setSelectedEnvNames] = useState<Set<string>>(new Set());
  const [importOutcome, setImportOutcome] = useState<
    | null
    | { kind: 'not_found'; fallbackProviderId?: string; fallbackProviderName?: string }
    | { kind: 'oauth_conflict'; providerId: string; providerName: string }
    | { kind: 'error'; message: string }
  >(null);

  // API key inline disclosure state.
  const [expandedKeyMode, setExpandedKeyMode] = useState<'paste' | 'custom' | null>(null);
  const [rawApiKey, setRawApiKey] = useState('');
  const [keyMasked, setKeyMasked] = useState(false);
  const [keyFocused, setKeyFocused] = useState(false);
  const [manualProviderId, setManualProviderId] = useState<string>('openai');
  const [apiKeyStatus, setApiKeyStatus] = useState<'idle' | 'validating' | 'success' | 'error'>(
    'idle'
  );
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [apiKeyShakeTick, setApiKeyShakeTick] = useState(0);
  const apiKeyHasShakenRef = useRef(false);

  // Custom provider inline disclosure state.
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customApiKey, setCustomApiKey] = useState('');
  const [customName, setCustomName] = useState('');
  const [customProtocol, setCustomProtocol] =
    useState<SorbetOnboardingCustomProtocol>('openai-completions');
  const [customStatus, setCustomStatus] = useState<'idle' | 'validating' | 'success' | 'error'>(
    'idle'
  );
  const [customError, setCustomError] = useState<string | null>(null);
  const [customShakeTick, setCustomShakeTick] = useState(0);
  const customHasShakenRef = useRef(false);

  // 600ms key masking after user pastes or stops typing (§5.3).
  useEffect(() => {
    setKeyMasked(false);
    if (!rawApiKey.trim()) return undefined;
    const timer = window.setTimeout(() => {
      setKeyMasked(true);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [rawApiKey]);

  const detectedProvider = useMemo(
    () => detectProviderFromApiKeyPrefix(rawApiKey),
    [rawApiKey]
  );

  const effectiveApiKeyProviderId = detectedProvider?.providerId ?? manualProviderId;

  const humanizeConnectFailure = useCallback(
    (code: string): string => {
      if (code === 'invalid_key') {
        return t('onboarding.model.apiKey.errorInvalid', {
          defaultValue: 'This key does not have access to models. Check the key and try again.',
        });
      }
      if (code === 'no_models') {
        return t('onboarding.model.apiKey.errorNoModels', {
          defaultValue: 'Connected, but this provider did not return any available models.',
        });
      }
      if (code === 'invalid_endpoint') {
        return t('onboarding.model.custom.errorEndpoint', {
          defaultValue: 'Enter a valid Base URL (for example https://api.example.com/v1).',
        });
      }
      if (code === 'network_error') {
        return t('onboarding.model.apiKey.errorNetwork', {
          defaultValue: 'Could not reach the provider endpoint. Check your network connection.',
        });
      }
      return t('onboarding.model.apiKey.errorGeneric', {
        defaultValue: 'Could not verify this credential right now.',
      });
    },
    [t]
  );

  const finishAfterHold = useCallback(
    (payload: ConnectedModelPayload) => {
      const holdMs = reducedMotion ? Math.round(HOLD_SUCCESS_MS * 0.5) : HOLD_SUCCESS_MS;
      window.setTimeout(() => {
        onConnected?.(payload);
      }, holdMs);
    },
    [onConnected, reducedMotion]
  );

  // Trigger subscription OAuth (also used by import cross-links!).
  const triggerOAuthForProvider = useCallback(
    async (providerId: string, fallbackName?: string) => {
      setShowAllOAuth(true);
      setExpandedImport(null);
      setExpandedKeyMode(null);
      const matched =
        oauthMethods.find((m) => m.providerId === providerId) ??
        oauthMethods.find(
          (m) =>
            (providerId === 'anthropic' && m.providerId.includes('anthropic')) ||
            (providerId.includes('openai') && m.providerId.includes('openai'))
        );
      const targetId = matched?.providerId ?? providerId;
      const targetName = matched?.providerName ?? fallbackName ?? providerId;
      await controller.startOAuth({ providerId: targetId, providerName: targetName });
    },
    [controller, oauthMethods]
  );

  const handleOpenImportRow = useCallback(
    async (source: ImportSourceId) => {
      if (expandedImport === source) {
        setExpandedImport(null);
        return;
      }
      setExpandedKeyMode(null);
      setExpandedImport(source);
      setImportOutcome(null);
      setEnvCandidates(null);
      setImportSuccessSource(null);
      const desc = await controller.describeImport(source);
      setImportDescription(desc);
    },
    [controller, expandedImport]
  );

  const handleConfirmImport = useCallback(
    async (source: ImportSourceId) => {
      setImportBusy(true);
      setImportOutcome(null);
      try {
        const result =
          source === 'env'
            ? envCandidates
              ? await controller.runImport({
                  source: 'env',
                  mode: 'confirm',
                  selectedEnvNames: [...selectedEnvNames],
                })
              : await controller.runImport({ source: 'env', mode: 'scan' })
            : await controller.runImport({ source });

        if (result.status === 'env_candidates') {
          setEnvCandidates(result.candidates);
          setSelectedEnvNames(new Set(result.candidates.map((c) => c.envName)));
          return;
        }

        if (result.status === 'imported') {
          setImportSuccessSource(source);
          finishAfterHold({
            providerId: result.providerId,
            providerName: result.providerName,
            modelSelector: result.modelSelector,
            modelName: result.modelName,
            source: result.connectionSource,
          });
          return;
        }

        if (result.status === 'oauth_conflict') {
          setImportOutcome({
            kind: 'oauth_conflict',
            providerId: result.providerId,
            providerName: result.providerName,
          });
          return;
        }

        if (result.status === 'not_found') {
          setImportOutcome({
            kind: 'not_found',
            fallbackProviderId: result.fallbackProviderId,
            fallbackProviderName: result.fallbackProviderName,
          });
          return;
        }

        setImportOutcome({
          kind: 'error',
          message:
            result.code === 'keychain_denied'
              ? t('onboarding.model.import.keychainDenied', {
                  defaultValue: 'Keychain access was declined, so Lody did not read credentials.',
                })
              : humanizeConnectFailure(result.code),
        });
      } finally {
        setImportBusy(false);
      }
    },
    [
      controller,
      envCandidates,
      finishAfterHold,
      humanizeConnectFailure,
      selectedEnvNames,
      t,
    ]
  );

  const submitApiKey = useCallback(
    async (keyToValidate: string, providerIdOverride?: string) => {
      const trimmed = keyToValidate.trim();
      const targetProvider = providerIdOverride ?? effectiveApiKeyProviderId;
      if (!trimmed || !targetProvider) return;

      setApiKeyStatus('validating');
      setApiKeyError(null);
      const result = await controller.connectApiKey({
        providerId: targetProvider,
        apiKey: trimmed,
      });

      if (result.ok) {
        setApiKeyStatus('success');
        finishAfterHold({
          providerId: result.providerId,
          providerName: result.providerName,
          modelSelector: result.modelSelector,
          modelName: result.modelName,
          source: result.source,
        });
        return;
      }

      setApiKeyStatus('error');
      setApiKeyError(humanizeConnectFailure(result.code));
      // Shake once per row lifetime; retries do not re-shake (§6.3).
      if (!apiKeyHasShakenRef.current && !reducedMotion) {
        apiKeyHasShakenRef.current = true;
        setApiKeyShakeTick((count) => count + 1);
      }
    },
    [
      controller,
      effectiveApiKeyProviderId,
      finishAfterHold,
      humanizeConnectFailure,
      reducedMotion,
    ]
  );

  const submitCustomProvider = useCallback(async () => {
    const trimmedUrl = customBaseUrl.trim();
    if (!trimmedUrl) {
      setCustomStatus('error');
      setCustomError(humanizeConnectFailure('invalid_endpoint'));
      if (!customHasShakenRef.current && !reducedMotion) {
        customHasShakenRef.current = true;
        setCustomShakeTick((count) => count + 1);
      }
      return;
    }

    setCustomStatus('validating');
    setCustomError(null);
    const result = await controller.connectCustomProvider({
      ...(customName.trim() ? { name: customName.trim() } : {}),
      baseUrl: trimmedUrl,
      protocol: customProtocol,
      ...(customApiKey.trim() ? { apiKey: customApiKey.trim() } : {}),
    });

    if (result.ok) {
      setCustomStatus('success');
      finishAfterHold({
        providerId: result.providerId,
        providerName: result.providerName,
        modelSelector: result.modelSelector,
        modelName: result.modelName,
        source: result.source,
      });
      return;
    }

    setCustomStatus('error');
    setCustomError(humanizeConnectFailure(result.code));
    if (!customHasShakenRef.current && !reducedMotion) {
      customHasShakenRef.current = true;
      setCustomShakeTick((count) => count + 1);
    }
  }, [
    controller,
    customApiKey,
    customBaseUrl,
    customName,
    customProtocol,
    finishAfterHold,
    humanizeConnectFailure,
    reducedMotion,
  ]);

  const oauthState = controller.oauthState;

  return (
    <div {...stylex.props(styles.root)} data-testid="connect-model-sheet">
      {showHeader ? (
        <header {...stylex.props(styles.header)}>
          <h1 {...stylex.props(flatSurface.heading)}>
            {t('onboarding.model.title', { defaultValue: 'Connect a model' })}
          </h1>
          <p {...stylex.props(flatSurface.subheading)}>
            {t('onboarding.model.subtitle', {
              defaultValue: 'Lody Agent thinks with it. Pick one way — only needed once.',
            })}
          </p>
        </header>
      ) : null}

      <div {...stylex.props(flatSurface.groupStack)}>
        {/* Group 1: Subscriptions */}
        <section {...stylex.props(flatSurface.groupBlock)}>
          <span {...stylex.props(flatSurface.groupLabel)}>
            {t('onboarding.model.group.subscription', {
              defaultValue: 'Sign in with a subscription',
            })}
          </span>
          <div {...stylex.props(styles.subscriptionGrid)}>
            {visibleOAuthMethods.map((method, index) => {
              const meta = resolveSubscriptionCardMeta(method);
              const isThisActive = oauthState.providerId === method.providerId;
              const phase = isThisActive
                ? oauthState.phase === 'starting' || oauthState.phase === 'waiting'
                  ? 'waiting'
                  : oauthState.phase === 'authenticated'
                    ? 'success'
                    : 'idle'
                : 'idle';
              return (
                <BrowserAuthButton
                  key={`${method.providerId}-${method.type}`}
                  variant="tile"
                  autoFocus={index === 0}
                  phase={phase}
                  label={meta.title}
                  subtitle={meta.subtitle}
                  icon={<ProviderBrandIcon providerId={method.providerId} size={16} />}
                  authorizationUrl={isThisActive ? oauthState.authorizationUrl : null}
                  userCode={isThisActive ? oauthState.userCode : null}
                  layoutId={phase === 'success' ? chipLayoutId : undefined}
                  data-testid={`connect-oauth-${method.providerId}`}
                  onStart={() =>
                    void controller.startOAuth({
                      providerId: method.providerId,
                      providerName: meta.title,
                    })
                  }
                  onCancel={() => void controller.cancelOAuth()}
                  onSuccessComplete={() => {
                    if (oauthState.phase === 'authenticated') {
                      onConnected?.({
                        providerId: oauthState.providerId ?? method.providerId,
                        providerName: oauthState.providerName ?? meta.title,
                        modelSelector: oauthState.modelSelector ?? '',
                        modelName: oauthState.modelName ?? '',
                        source: oauthState.source ?? { kind: 'oauth' },
                      });
                    }
                  }}
                />
              );
            })}

            {!showAllOAuth && oauthMethods.length > 3 ? (
              <button
                type="button"
                onClick={() => setShowAllOAuth(true)}
                {...stylex.props(styles.moreTile)}
              >
                <span>{t('onboarding.model.more', { defaultValue: 'More' })}</span>
                <ChevronDown size={14} aria-hidden="true" />
              </button>
            ) : null}
          </div>
          {oauthState.phase === 'error' && oauthState.error ? (
            <p {...stylex.props(styles.errorText)} role="alert">
              {t('onboarding.model.oauthError', {
                defaultValue: 'Browser sign-in did not finish. Try again or copy the link.',
              })}
            </p>
          ) : null}
        </section>

        {/* Group 2: Import from other tools */}
        <section {...stylex.props(flatSurface.groupBlock)}>
          <span {...stylex.props(flatSurface.groupLabel)}>
            {t('onboarding.model.group.import', {
              defaultValue: 'Import from other tools',
            })}
          </span>
          <div {...stylex.props(styles.rowStack)}>
            {IMPORT_ROWS.map((row) => {
              const isOpen = expandedImport === row.id;
              const isSucceeded = importSuccessSource === row.id;
              const rowTitle =
                row.id === 'env'
                  ? t('onboarding.model.import.envTitle', {
                      defaultValue: 'Environment variables',
                    })
                  : row.label;

              return (
                <motion.div
                  key={row.id}
                  layout={!reducedMotion}
                  layoutId={isSucceeded && !reducedMotion ? chipLayoutId : undefined}
                  {...stylex.props(flatSurface.flatRow)}
                >
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    data-testid={`import-row-${row.id}`}
                    onClick={() => void handleOpenImportRow(row.id)}
                    {...stylex.props(flatSurface.flatRowTrigger)}
                  >
                    <span {...stylex.props(styles.rowLeading)}>
                      {isOpen ? (
                        <ChevronDown size={14} style={{ opacity: 0.55 }} aria-hidden="true" />
                      ) : (
                        <ChevronRight size={14} style={{ opacity: 0.55 }} aria-hidden="true" />
                      )}
                      <span>{rowTitle}</span>
                    </span>
                    {isSucceeded ? (
                      <span {...stylex.props(styles.successInline)}>
                        <StatusRingOrCheck phase="success" reducedMotion={reducedMotion} />
                        <span>{t('onboarding.auth.connected', { defaultValue: 'Connected' })}</span>
                      </span>
                    ) : (
                      <span {...stylex.props(styles.rowActionText)}>
                        {t('onboarding.model.import.action', { defaultValue: 'Import' })}
                      </span>
                    )}
                  </button>

                  <AnimatePresence initial={false}>
                    {isOpen && !isSucceeded ? (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={heightTransition(reducedMotion)}
                        style={{ overflow: 'hidden' }}
                      >
                        <div {...stylex.props(styles.expandedBody)}>
                          {!importOutcome && !envCandidates ? (
                            <>
                              <p {...stylex.props(styles.bodyText)}>
                                {row.id === 'claude-code'
                                  ? t('onboarding.model.import.claudeDescribe', {
                                      defaultValue:
                                        'Reads your Claude Code credentials and copies them into Lody. Claude Code itself stays untouched.',
                                    })
                                  : row.id === 'codex'
                                    ? t('onboarding.model.import.codexDescribe', {
                                        defaultValue:
                                          'Reads credentials from ~/.codex/auth.json and copies them into Lody. Codex itself stays untouched.',
                                      })
                                    : t('onboarding.model.import.envDescribe', {
                                        defaultValue:
                                          'Reads model API keys from your login shell ($SHELL -ilc env) so you can choose which ones to import.',
                                      })}
                              </p>
                              {row.id === 'claude-code' &&
                              importDescription?.systemPromptKind === 'macos-keychain' ? (
                                <p {...stylex.props(styles.systemPromptNotice)}>
                                  {t('onboarding.model.import.macosKeychainNotice', {
                                    defaultValue:
                                      'macOS may ask to allow Keychain access — choose "Allow".',
                                  })}
                                </p>
                              ) : null}
                              <div {...stylex.props(styles.actionRow)}>
                                <button
                                  type="button"
                                  onClick={() => setExpandedImport(null)}
                                  {...stylex.props(flatSurface.quietButton)}
                                >
                                  {t('common.cancel', { defaultValue: 'Cancel' })}
                                </button>
                                <button
                                  type="button"
                                  disabled={importBusy}
                                  data-testid={`confirm-import-${row.id}`}
                                  onClick={() => void handleConfirmImport(row.id)}
                                  {...stylex.props(flatSurface.primaryPill)}
                                >
                                  {importBusy ? (
                                    <StatusRingOrCheck
                                      phase="waiting"
                                      reducedMotion={reducedMotion}
                                    />
                                  ) : null}
                                  <span>
                                    {t('onboarding.model.import.confirm', {
                                      defaultValue: 'Confirm import',
                                    })}
                                  </span>
                                </button>
                              </div>
                            </>
                          ) : null}

                          {envCandidates ? (
                            <>
                              <div {...stylex.props(styles.envList)}>
                                {envCandidates.map((candidate) => {
                                  const checked = selectedEnvNames.has(candidate.envName);
                                  return (
                                    <label
                                      key={candidate.envName}
                                      {...stylex.props(styles.envItem)}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        onChange={() => {
                                          setSelectedEnvNames((prev) => {
                                            const next = new Set(prev);
                                            if (next.has(candidate.envName)) {
                                              next.delete(candidate.envName);
                                            } else {
                                              next.add(candidate.envName);
                                            }
                                            return next;
                                          });
                                        }}
                                        style={{
                                          position: 'absolute',
                                          width: 1,
                                          height: 1,
                                          opacity: 0,
                                          pointerEvents: 'none',
                                          margin: 0,
                                        }}
                                      />
                                      <span {...stylex.props(styles.envCheckbox)}>
                                        <span
                                          {...stylex.props(
                                            styles.checkBoxSquare,
                                            checked && styles.checkBoxSquareChecked
                                          )}
                                          aria-hidden="true"
                                        >
                                          {checked ? <Check size={11} strokeWidth={2.5} /> : null}
                                        </span>
                                        <span>{candidate.envName}</span>
                                      </span>
                                      <span {...stylex.props(styles.maskedTail)}>
                                        {candidate.providerName} · ····{candidate.last4}
                                      </span>
                                    </label>
                                  );
                                })}
                              </div>
                              <div {...stylex.props(styles.actionRow)}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEnvCandidates(null);
                                    setExpandedImport(null);
                                  }}
                                  {...stylex.props(flatSurface.quietButton)}
                                >
                                  {t('common.cancel', { defaultValue: 'Cancel' })}
                                </button>
                                <button
                                  type="button"
                                  disabled={importBusy || selectedEnvNames.size === 0}
                                  data-testid="confirm-import-env-selected"
                                  onClick={() => void handleConfirmImport('env')}
                                  {...stylex.props(flatSurface.primaryPill)}
                                >
                                  {importBusy ? (
                                    <StatusRingOrCheck
                                      phase="waiting"
                                      reducedMotion={reducedMotion}
                                    />
                                  ) : null}
                                  <span>
                                    {t('onboarding.model.import.importSelected', {
                                      defaultValue: 'Import selected',
                                    })}
                                  </span>
                                </button>
                              </div>
                            </>
                          ) : null}

                          {importOutcome?.kind === 'not_found' ? (
                            <>
                              <p {...stylex.props(styles.bodyText)}>
                                {row.id === 'claude-code'
                                  ? t('onboarding.model.import.notFoundClaude', {
                                      defaultValue: 'No Claude Code sign-in record was found.',
                                    })
                                  : row.id === 'codex'
                                    ? t('onboarding.model.import.notFoundCodex', {
                                        defaultValue: 'No Codex sign-in record was found.',
                                      })
                                    : t('onboarding.model.import.notFoundEnv', {
                                        defaultValue:
                                          'No recognized model API keys were found in your shell environment.',
                                      })}
                              </p>
                              {importOutcome.fallbackProviderId ? (
                                <div>
                                  <button
                                    type="button"
                                    data-testid={`import-fallback-oauth-${row.id}`}
                                    onClick={() =>
                                      void triggerOAuthForProvider(
                                        importOutcome.fallbackProviderId!,
                                        importOutcome.fallbackProviderName
                                      )
                                    }
                                    {...stylex.props(flatSurface.inlineLink)}
                                  >
                                    <span>
                                      {t('onboarding.model.import.switchToSubscription', {
                                        provider:
                                          importOutcome.fallbackProviderName ?? 'subscription',
                                        defaultValue: `Sign in with ${importOutcome.fallbackProviderName ?? 'subscription'} instead`,
                                      })}
                                    </span>
                                    <ArrowRight size={13} aria-hidden="true" />
                                  </button>
                                </div>
                              ) : null}
                            </>
                          ) : null}

                          {importOutcome?.kind === 'oauth_conflict' ? (
                            <>
                              <p {...stylex.props(styles.bodyText)}>
                                {t('onboarding.model.import.oauthRotateNotice', {
                                  defaultValue:
                                    'Subscription tokens rotate on refresh — copying them directly would sign out your existing CLI. Sign in once here so both tools stay active.',
                                })}
                              </p>
                              <div>
                                <button
                                  type="button"
                                  data-testid={`import-relogin-oauth-${row.id}`}
                                  onClick={() =>
                                    void triggerOAuthForProvider(
                                      importOutcome.providerId,
                                      importOutcome.providerName
                                    )
                                  }
                                  {...stylex.props(flatSurface.inlineLink)}
                                >
                                  <span>
                                    {t('onboarding.model.import.reloginSubscription', {
                                      provider: importOutcome.providerName,
                                      defaultValue: `Sign in with ${importOutcome.providerName}`,
                                    })}
                                  </span>
                                  <ArrowRight size={13} aria-hidden="true" />
                                </button>
                              </div>
                            </>
                          ) : null}

                          {importOutcome?.kind === 'error' ? (
                            <p {...stylex.props(styles.errorText)} role="alert">
                              {importOutcome.message}
                            </p>
                          ) : null}
                        </div>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </div>
        </section>

        {/* Group 3: API Key & Custom Provider */}
        <section {...stylex.props(flatSurface.groupBlock)}>
          <span {...stylex.props(flatSurface.groupLabel)}>
            {t('onboarding.model.group.apiKey', { defaultValue: 'Use an API key' })}
          </span>
          <div {...stylex.props(styles.rowStack)}>
            {/* Paste API Key row */}
            <motion.div
              key={`paste-key-${apiKeyShakeTick}`}
              animate={
                apiKeyShakeTick > 0 && !reducedMotion ? { x: [0, -3, 3, -3, 3, 0] } : undefined
              }
              transition={{ duration: SHAKE_DURATION_S, ease: EASE_OUT }}
              layout={!reducedMotion}
              layoutId={
                apiKeyStatus === 'success' && !reducedMotion ? chipLayoutId : undefined
              }
              {...stylex.props(flatSurface.flatRow)}
            >
              <button
                type="button"
                aria-expanded={expandedKeyMode === 'paste'}
                data-testid="expand-paste-api-key"
                onClick={() => {
                  setExpandedImport(null);
                  setExpandedKeyMode((prev) => (prev === 'paste' ? null : 'paste'));
                }}
                {...stylex.props(flatSurface.flatRowTrigger)}
              >
                <span>
                  {t('onboarding.model.apiKey.pasteTitle', { defaultValue: 'Paste API Key' })}
                </span>
                {apiKeyStatus === 'success' ? (
                  <span {...stylex.props(styles.successInline)}>
                    <StatusRingOrCheck phase="success" reducedMotion={reducedMotion} />
                    <span>{t('onboarding.auth.connected', { defaultValue: 'Connected' })}</span>
                  </span>
                ) : (
                  <ChevronDown
                    size={14}
                    style={{
                      opacity: 0.55,
                      transform: expandedKeyMode === 'paste' ? 'rotate(180deg)' : 'none',
                      transition: 'transform 160ms ease',
                    }}
                    aria-hidden="true"
                  />
                )}
              </button>

              <AnimatePresence initial={false}>
                {expandedKeyMode === 'paste' && apiKeyStatus !== 'success' ? (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={heightTransition(reducedMotion)}
                    style={{ overflow: 'hidden' }}
                  >
                    <div {...stylex.props(styles.expandedBody)}>
                      <div {...stylex.props(styles.keyFieldWrap)}>
                        <ProviderBrandIcon
                          providerId={detectedProvider ? effectiveApiKeyProviderId : null}
                          neutral={!detectedProvider}
                          size={16}
                        />
                        <input
                          type="text"
                          autoFocus
                          autoComplete="off"
                          spellCheck={false}
                          data-testid="api-key-input"
                          placeholder={t('onboarding.model.apiKey.placeholder', {
                            defaultValue: 'sk-ant-… / sk-… / AIza…',
                          })}
                          value={
                            keyMasked && !keyFocused ? maskApiKeyDisplay(rawApiKey) : rawApiKey
                          }
                          onFocus={() => setKeyFocused(true)}
                          onBlur={() => setKeyFocused(false)}
                          onChange={(event) => {
                            setRawApiKey(event.target.value);
                            setApiKeyStatus('idle');
                            setApiKeyError(null);
                          }}
                          onPaste={(event) => {
                            const pasted = event.clipboardData.getData('text').trim();
                            if (!pasted) return;
                            event.preventDefault();
                            setRawApiKey(pasted);
                            const auto = detectProviderFromApiKeyPrefix(pasted);
                            if (auto?.confidence === 'exact') {
                              void submitApiKey(pasted, auto.providerId);
                            }
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && rawApiKey.trim()) {
                              event.preventDefault();
                              void submitApiKey(rawApiKey);
                            }
                          }}
                          {...stylex.props(styles.bareInput)}
                        />
                        {apiKeyStatus === 'validating' ? (
                          <StatusRingOrCheck phase="waiting" reducedMotion={reducedMotion} />
                        ) : null}
                      </div>

                      {rawApiKey.trim() && (!detectedProvider || detectedProvider.confidence === 'shared-prefix') ? (
                        <div {...stylex.props(styles.providerSelectRow)}>
                          <span {...stylex.props(styles.bodyText)}>
                            {t('onboarding.model.apiKey.providerLabel', {
                              defaultValue: 'Provider',
                            })}
                          </span>
                          <select
                            aria-label={t('onboarding.model.apiKey.providerLabel', {
                              defaultValue: 'Provider',
                            })}
                            value={
                              detectedProvider
                                ? manualProviderId === 'deepseek'
                                  ? 'deepseek'
                                  : detectedProvider.providerId
                                : manualProviderId
                            }
                            onChange={(event) => {
                              setManualProviderId(event.target.value);
                            }}
                            {...stylex.props(styles.nativeSelect)}
                          >
                            {API_KEY_PROVIDER_OPTIONS.map((opt) => (
                              <option key={opt.providerId} value={opt.providerId}>
                                {opt.providerName}
                              </option>
                            ))}
                          </select>
                        </div>
                      ) : null}

                      {apiKeyError ? (
                        <p {...stylex.props(styles.errorText)} role="alert">
                          {apiKeyError}
                        </p>
                      ) : null}

                      <div {...stylex.props(styles.actionRow)}>
                        <button
                          type="button"
                          disabled={!rawApiKey.trim() || apiKeyStatus === 'validating'}
                          data-testid="submit-api-key"
                          onClick={() =>
                            void submitApiKey(
                              rawApiKey,
                              detectedProvider?.confidence === 'shared-prefix' &&
                                manualProviderId === 'deepseek'
                                ? 'deepseek'
                                : effectiveApiKeyProviderId
                            )
                          }
                          {...stylex.props(flatSurface.primaryPill)}
                        >
                          <span>
                            {t('onboarding.model.apiKey.connect', { defaultValue: 'Verify & connect' })}
                          </span>
                        </button>
                      </div>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </motion.div>

            {/* Custom Provider row */}
            <motion.div
              key={`custom-provider-${customShakeTick}`}
              animate={
                customShakeTick > 0 && !reducedMotion ? { x: [0, -3, 3, -3, 3, 0] } : undefined
              }
              transition={{ duration: SHAKE_DURATION_S, ease: EASE_OUT }}
              layout={!reducedMotion}
              layoutId={
                customStatus === 'success' && !reducedMotion ? chipLayoutId : undefined
              }
              {...stylex.props(flatSurface.flatRow)}
            >
              <button
                type="button"
                aria-expanded={expandedKeyMode === 'custom'}
                data-testid="expand-custom-provider"
                onClick={() => {
                  setExpandedImport(null);
                  setExpandedKeyMode((prev) => (prev === 'custom' ? null : 'custom'));
                }}
                {...stylex.props(flatSurface.flatRowTrigger)}
              >
                <span>
                  {t('onboarding.model.custom.title', {
                    defaultValue: 'Custom Provider (OpenAI compatible)',
                  })}
                </span>
                {customStatus === 'success' ? (
                  <span {...stylex.props(styles.successInline)}>
                    <StatusRingOrCheck phase="success" reducedMotion={reducedMotion} />
                    <span>{t('onboarding.auth.connected', { defaultValue: 'Connected' })}</span>
                  </span>
                ) : (
                  <ChevronDown
                    size={14}
                    style={{
                      opacity: 0.55,
                      transform: expandedKeyMode === 'custom' ? 'rotate(180deg)' : 'none',
                      transition: 'transform 160ms ease',
                    }}
                    aria-hidden="true"
                  />
                )}
              </button>

              <AnimatePresence initial={false}>
                {expandedKeyMode === 'custom' && customStatus !== 'success' ? (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={heightTransition(reducedMotion)}
                    style={{ overflow: 'hidden' }}
                  >
                    <div {...stylex.props(styles.expandedBody)}>
                      <div {...stylex.props(styles.customFields)}>
                        <input
                          type="url"
                          autoFocus
                          data-testid="custom-provider-base-url"
                          placeholder="https://api.example.com/v1"
                          value={customBaseUrl}
                          onChange={(event) => {
                            setCustomBaseUrl(event.target.value);
                            setCustomError(null);
                          }}
                          {...stylex.props(flatSurface.flatInput)}
                        />
                        <input
                          type="password"
                          autoComplete="off"
                          data-testid="custom-provider-api-key"
                          placeholder={t('onboarding.model.custom.keyPlaceholder', {
                            defaultValue: 'API Key',
                          })}
                          value={customApiKey}
                          onChange={(event) => {
                            setCustomApiKey(event.target.value);
                            setCustomError(null);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && customBaseUrl.trim()) {
                              event.preventDefault();
                              void submitCustomProvider();
                            }
                          }}
                          {...stylex.props(flatSurface.flatInput)}
                        />
                        <input
                          type="text"
                          data-testid="custom-provider-name"
                          placeholder={t('onboarding.model.custom.namePlaceholder', {
                            defaultValue: 'Display name (optional)',
                          })}
                          value={customName}
                          onChange={(event) => setCustomName(event.target.value)}
                          {...stylex.props(flatSurface.flatInput)}
                        />
                        <div
                          role="radiogroup"
                          aria-label={t('onboarding.model.custom.protocolLabel', {
                            defaultValue: 'Protocol',
                          })}
                          {...stylex.props(styles.protocolPills)}
                        >
                          {(
                            [
                              { id: 'openai-completions', label: 'OpenAI Chat' },
                              { id: 'openai-responses', label: 'OpenAI Responses' },
                              { id: 'anthropic-messages', label: 'Anthropic' },
                            ] as const
                          ).map((item) => {
                            const active = customProtocol === item.id;
                            return (
                              <button
                                key={item.id}
                                type="button"
                                role="radio"
                                aria-checked={active}
                                onClick={() => setCustomProtocol(item.id)}
                                {...stylex.props(
                                  styles.protocolPill,
                                  active && styles.protocolPillActive
                                )}
                              >
                                {item.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {customError ? (
                        <p {...stylex.props(styles.errorText)} role="alert">
                          {customError}
                        </p>
                      ) : null}

                      <div {...stylex.props(styles.actionRow)}>
                        <button
                          type="button"
                          disabled={!customBaseUrl.trim() || customStatus === 'validating'}
                          data-testid="submit-custom-provider"
                          onClick={() => void submitCustomProvider()}
                          {...stylex.props(flatSurface.primaryPill)}
                        >
                          {customStatus === 'validating' ? (
                            <StatusRingOrCheck phase="waiting" reducedMotion={reducedMotion} />
                          ) : null}
                          <span>
                            {t('onboarding.model.apiKey.connect', {
                              defaultValue: 'Verify & connect',
                            })}
                          </span>
                        </button>
                      </div>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </motion.div>
          </div>
        </section>
      </div>

      {onSkip ? (
        <div {...stylex.props(styles.footerRow)}>
          <button
            type="button"
            data-testid="onboarding-model-skip"
            onClick={onSkip}
            {...stylex.props(flatSurface.quietButton)}
          >
            {skipLabel ?? t('onboarding.model.skipForNow', { defaultValue: 'Later' })}
          </button>
        </div>
      ) : null}
    </div>
  );
}
