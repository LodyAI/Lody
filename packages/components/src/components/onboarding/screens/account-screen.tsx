import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useAtomValue, useSetAtom } from 'jotai';
import * as stylex from '@stylexjs/stylex';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Plus, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePlatform, usePlatformSession, usePlatformWorkspaces } from '@lody/platform/react';
import type { WorkspaceId } from '@lody/shared';
import {
  electronLoginErrorAtom,
  electronLoginErrorDetailAtom,
  electronLoginPhaseAtom,
} from '@/atoms';
import type { DesktopOnboardingAccountChip } from '@/atoms/onboarding';
import { setWorkspaceContextAtom } from '@/atoms/workspace-context';
import {
  EncryptedWorkspaceMark,
  isListedEncryptedWorkspace,
} from '@/components/e2ee/encrypted-workspace-mark';
import { getIpcServices, onIpcEvent } from '@/lib/electron-ipc-client';
import { generateWorkspaceSlug, isUsableWorkspaceSlug } from '@/lib/workspace';
import { playSelect } from '../ceremony/ui-sounds';
import {
  HOLD_SUCCESS_MS,
  heightTransition,
  staggerDelay,
  useOnboardingReducedMotion,
} from '../motion-tokens';
import { useOnboardingAnalytics } from '../onboarding-analytics';
import { ACCOUNT_CHIP_LAYOUT_ID } from '../onboarding-chip-rail';
import { BrowserAuthButton, StatusRingOrCheck } from '../shared/browser-auth-button';
import { flatSurface } from '../shared/flat-surface.stylex';

type ElectronBrowserSignInClient = {
  signIn: {
    social: (input: { callbackURL: string }) => Promise<unknown>;
  };
};

interface WorkspaceOption {
  id: string;
  name: string;
  slug: string;
  encrypted: boolean;
}

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem',
    width: '100%',
  },
  header: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  title: {
    margin: 0,
    fontSize: 'clamp(1.85rem, 3vw, 2.4rem)',
    fontWeight: 620,
    letterSpacing: '-0.03em',
    lineHeight: 1.15,
    color: 'var(--flat-ink)',
  },
  subtitle: {
    margin: 0,
    fontSize: '0.96875rem',
    lineHeight: 1.55,
    color: 'var(--flat-ink-secondary)',
  },
  actionArea: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '0.75rem',
  },
  errorText: {
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.5,
    color: 'var(--flat-danger-fg)',
  },
  workspaceBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.625rem',
    width: '100%',
  },
  workspaceList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.3125rem',
    maxHeight: '16rem',
    overflowY: 'auto',
  },
  workspaceItem: {
    appearance: 'none',
    borderWidth: 0,
    borderRadius: '11px',
    backgroundColor: 'var(--flat-fill)',
    color: 'var(--flat-ink)',
    width: '100%',
    paddingBlock: '0.6875rem',
    paddingInline: '0.875rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
    fontSize: '0.875rem',
    fontWeight: 500,
    cursor: 'pointer',
    textAlign: 'start',
    transitionProperty: 'background-color, transform',
    transitionDuration: '120ms, 80ms',
    ':hover': {
      backgroundColor: 'var(--flat-fill-hover)',
    },
    ':active': {
      transform: 'scale(0.99)',
    },
    ':focus-visible': {
      outline: '2px solid var(--flat-ink)',
      outlineOffset: '-2px',
    },
  },
  workspaceItemActive: {
    backgroundColor: 'var(--flat-fill-strong)',
  },
  workspaceItemMeta: {
    fontSize: '0.75rem',
    color: 'var(--flat-ink-tertiary)',
    fontWeight: 400,
  },
  createForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.625rem',
    paddingTop: '0.25rem',
  },
  footerLinks: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
    paddingTop: '0.5rem',
    fontSize: '0.75rem',
    color: 'var(--flat-ink-tertiary)',
  },
  legalBtn: {
    appearance: 'none',
    borderWidth: 0,
    padding: 0,
    backgroundColor: 'transparent',
    color: 'var(--flat-ink-tertiary)',
    fontSize: '0.75rem',
    cursor: 'pointer',
    transitionProperty: 'color',
    transitionDuration: '120ms',
    ':hover': {
      color: 'var(--flat-ink-secondary)',
    },
  },
});

export function AccountScreen({
  revisiting = false,
  onCompleted,
}: {
  /** True when user clicked the top Account chip to switch workspaces. */
  revisiting?: boolean;
  onCompleted: (chip: DesktopOnboardingAccountChip) => void;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const authClient = router.options.context?.authClient;
  const reducedMotion = useOnboardingReducedMotion();
  const analytics = useOnboardingAnalytics();
  const platform = usePlatform();
  const session = usePlatformSession();
  const workspaceState = usePlatformWorkspaces();
  const setWorkspaceContext = useSetAtom(setWorkspaceContextAtom);

  const electronLoginPhase = useAtomValue(electronLoginPhaseAtom);
  const electronLoginError = useAtomValue(electronLoginErrorAtom);
  const electronLoginErrorDetail = useAtomValue(electronLoginErrorDetailAtom);

  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [startingSignIn, setStartingSignIn] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [authCheckDone, setAuthCheckDone] = useState(false);
  const playedConnectSoundRef = useRef(false);
  const autoCommittedSingleRef = useRef(false);
  const attemptRef = useRef(0);

  // Sync authorizationUrl from Electron main `auth` service for the "Copy link" button.
  useEffect(() => {
    const authIpc = getIpcServices()?.auth;
    if (!authIpc) return undefined;
    void Promise.resolve(authIpc.getLoginState())
      .then((state) => {
        if (state?.authorizationUrl) setAuthorizationUrl(state.authorizationUrl);
      })
      .catch(() => undefined);
    return onIpcEvent('auth.loginState', (state) => {
      setAuthorizationUrl(state.authorizationUrl ?? null);
    });
  }, []);

  const userLabel = useMemo(() => {
    if (session.status !== 'authenticated') return 'Account';
    return (
      session.user.name?.trim() ||
      session.user.email?.split('@')[0]?.trim() ||
      'Account'
    );
  }, [session]);

  const workspaces = useMemo<WorkspaceOption[]>(
    () =>
      (workspaceState.status === 'ready' ? workspaceState.workspaces : []).map((ws) => ({
        id: ws.id,
        name: ws.name,
        slug: ws.slug ?? '',
        encrypted: isListedEncryptedWorkspace(ws),
      })),
    [workspaceState]
  );

  const activeWorkspaceId =
    workspaceState.status === 'ready' ? workspaceState.activeWorkspaceId : null;

  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('Personal');
  const [activating, setActivating] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  // Pre-highlight the most recently active workspace when the list resolves (§5.2).
  useEffect(() => {
    if (workspaces.length === 0) return;
    const idx = activeWorkspaceId
      ? workspaces.findIndex((ws) => ws.id === activeWorkspaceId)
      : 0;
    setHighlightedIndex(idx >= 0 ? idx : 0);
  }, [activeWorkspaceId, workspaces]);

  const activateAndFinish = useCallback(
    async (target: WorkspaceOption) => {
      if (activating) return;
      let resolvedSlug = target.slug;
      setActivating(true);
      setWorkspaceError(null);
      try {
        if (!resolvedSlug) {
          const generated = generateWorkspaceSlug(target.name || 'personal');
          const fallbackSlug = isUsableWorkspaceSlug(generated)
            ? generated
            : `ws-${target.id.slice(0, 6).toLowerCase()}`;
          if (platform.workspaces.updateSlug) {
            await platform.workspaces.updateSlug(target.id as WorkspaceId, fallbackSlug);
          }
          resolvedSlug = fallbackSlug;
        }

        if (target.id !== activeWorkspaceId && platform.workspaces.setActive) {
          await platform.workspaces.setActive(target.id as WorkspaceId);
        }

        setWorkspaceContext({
          slug: resolvedSlug,
          workspaceId: target.id as WorkspaceId,
        });

        analytics.capture('onboarding/operation_succeeded', {
          step: 'account',
          operation: 'workspace_switch',
        });

        onCompleted({
          userLabel,
          workspaceName: target.name,
          workspaceSlug: resolvedSlug,
        });
      } catch (err) {
        setWorkspaceError(err instanceof Error ? err.message : String(err));
      } finally {
        setActivating(false);
      }
    },
    [
      activating,
      activeWorkspaceId,
      analytics,
      onCompleted,
      platform.workspaces,
      setWorkspaceContext,
      userLabel,
    ]
  );

  // Play sound once when browser sign-in completes (§6.3: only on account connected & first send).
  useEffect(() => {
    if (session.status !== 'authenticated') return;
    if (!playedConnectSoundRef.current && attemptRef.current > 0) {
      playedConnectSoundRef.current = true;
      playSelect();
      analytics.capture('onboarding/operation_succeeded', {
        step: 'account',
        operation: 'browser_sign_in',
        attempt: attemptRef.current,
      });
    }
    const holdMs =
      attemptRef.current > 0
        ? reducedMotion
          ? Math.round(HOLD_SUCCESS_MS * 0.5)
          : HOLD_SUCCESS_MS
        : 0;
    const timer = window.setTimeout(() => {
      setAuthCheckDone(true);
    }, holdMs);
    return () => window.clearTimeout(timer);
  }, [analytics, reducedMotion, session.status]);

  // Auto-select and skip workspace picker when user has exactly 1 workspace (§1, §5.2),
  // unless they explicitly clicked the Account chip to revisit (`revisiting === true`).
  useEffect(() => {
    if (
      session.status !== 'authenticated' ||
      !authCheckDone ||
      workspaceState.status !== 'ready' ||
      revisiting ||
      autoCommittedSingleRef.current
    ) {
      return;
    }
    if (workspaces.length === 1 && workspaces[0]) {
      autoCommittedSingleRef.current = true;
      void activateAndFinish(workspaces[0]);
    } else if (workspaces.length === 0) {
      setCreatingWorkspace(true);
    }
  }, [
    activateAndFinish,
    authCheckDone,
    revisiting,
    session.status,
    workspaceState.status,
    workspaces,
  ]);

  // Keyboard navigation (`↑` / `↓` / `⏎`) when choosing among multiple workspaces (§5.2).
  const showWorkspaceList =
    session.status === 'authenticated' &&
    authCheckDone &&
    workspaceState.status === 'ready' &&
    workspaces.length > 0 &&
    !creatingWorkspace &&
    (workspaces.length > 1 || revisiting);

  useEffect(() => {
    if (!showWorkspaceList) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlightedIndex((idx) => (idx + 1) % workspaces.length);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlightedIndex((idx) => (idx - 1 + workspaces.length) % workspaces.length);
      } else if (event.key === 'Enter') {
        const picked = workspaces[highlightedIndex];
        if (picked) {
          event.preventDefault();
          void activateAndFinish(picked);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activateAndFinish, highlightedIndex, showWorkspaceList, workspaces]);

  const handleStartSignIn = useCallback(() => {
    const attempt = ++attemptRef.current;
    setStartingSignIn(true);
    setLocalError(null);
    analytics.capture('onboarding/operation_started', {
      step: 'account',
      operation: 'browser_sign_in',
      attempt,
    });

    if (authClient) {
      void (authClient as unknown as ElectronBrowserSignInClient).signIn
        .social({ callbackURL: '/onboarding' })
        .catch((err: unknown) => {
          setLocalError(err instanceof Error ? err.message : String(err));
          analytics.capture('onboarding/operation_failed', {
            step: 'account',
            operation: 'browser_sign_in',
            failure_code: 'browser_sign_in_failed',
            attempt,
            retryable: true,
          });
        })
        .finally(() => setStartingSignIn(false));
      return;
    }

    const authIpc = getIpcServices()?.auth;
    if (authIpc) {
      void authIpc
        .startLogin()
        .catch((err: unknown) => {
          setLocalError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setStartingSignIn(false));
    } else {
      setStartingSignIn(false);
    }
  }, [analytics, authClient]);

  const handleCancelSignIn = useCallback(() => {
    setStartingSignIn(false);
    void Promise.resolve(getIpcServices()?.auth.cancelLogin()).catch(() => undefined);
  }, []);

  const handleCreateWorkspace = useCallback(async () => {
    const trimmed = newWorkspaceName.trim();
    if (!trimmed || activating || !platform.workspaces.create) return;
    setActivating(true);
    setWorkspaceError(null);
    try {
      const baseSlug = generateWorkspaceSlug(trimmed) || `ws-${Date.now().toString(36)}`;
      const created = await platform.workspaces.create({
        name: trimmed,
        slug: baseSlug,
      });
      setWorkspaceContext({
        slug: created.slug ?? baseSlug,
        workspaceId: created.id as WorkspaceId,
      });
      analytics.capture('onboarding/operation_succeeded', {
        step: 'account',
        operation: 'workspace_create',
      });
      onCompleted({
        userLabel,
        workspaceName: created.name || trimmed,
        workspaceSlug: created.slug ?? baseSlug,
      });
    } catch (err) {
      setWorkspaceError(err instanceof Error ? err.message : String(err));
    } finally {
      setActivating(false);
    }
  }, [
    activating,
    analytics,
    newWorkspaceName,
    onCompleted,
    platform.workspaces,
    setWorkspaceContext,
    userLabel,
  ]);

  const openLegalUrl = useCallback((url: string) => {
    const appIpc = getIpcServices()?.app;
    if (appIpc) {
      void appIpc.openExternalUrl(url);
    } else if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }, []);

  const buttonPhase =
    session.status === 'authenticated'
      ? 'success'
      : electronLoginPhase === 'waiting' || electronLoginPhase === 'exchanging' || startingSignIn
        ? 'waiting'
        : 'idle';

  const errorMessage =
    localError ??
    (electronLoginPhase === 'error' && electronLoginError
      ? t(`login.desktopErrors.${electronLoginError}`, {
          defaultValue: electronLoginErrorDetail ?? 'Sign-in did not complete. Please try again.',
        })
      : null);

  return (
    <div {...stylex.props(styles.root)} data-testid="onboarding-account-screen">
      <header {...stylex.props(styles.header)}>
        <h1 {...stylex.props(styles.title)}>
          {showWorkspaceList || creatingWorkspace
            ? t('onboarding.account.workspaceTitle', { defaultValue: 'Choose a workspace' })
            : t('onboarding.account.title', { defaultValue: 'Ready to set off' })}
        </h1>
        <p {...stylex.props(styles.subtitle)}>
          {showWorkspaceList || creatingWorkspace
            ? t('onboarding.account.workspaceSubtitle', {
                defaultValue: 'Pick where your sessions and projects live.',
              })
            : t('onboarding.account.subtitle', {
                defaultValue: 'Once signed in, your tasks keep running across every device.',
              })}
        </p>
      </header>

      <AnimatePresence mode="wait" initial={false}>
        {session.status !== 'authenticated' || !authCheckDone ? (
          <motion.div
            key="sign-in-controls"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={heightTransition(reducedMotion)}
            {...stylex.props(styles.actionArea)}
          >
            <BrowserAuthButton
              variant="primary"
              autoFocus
              phase={buttonPhase}
              label={t('onboarding.account.signInBrowser', {
                defaultValue: 'Sign in with browser',
              })}
              authorizationUrl={authorizationUrl}
              layoutId={
                workspaces.length <= 1 && !revisiting ? ACCOUNT_CHIP_LAYOUT_ID : undefined
              }
              data-testid="onboarding-account-signin"
              onStart={handleStartSignIn}
              onCancel={handleCancelSignIn}
            />

            {errorMessage ? (
              <p {...stylex.props(styles.errorText)} role="alert">
                {errorMessage}
              </p>
            ) : null}

            <div {...stylex.props(styles.footerLinks)}>
              <button
                type="button"
                onClick={() => openLegalUrl('https://lody.ai/privacy')}
                {...stylex.props(styles.legalBtn)}
              >
                {t('onboarding.account.privacy', { defaultValue: 'Privacy' })}
              </button>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={() => openLegalUrl('https://lody.ai/terms')}
                {...stylex.props(styles.legalBtn)}
              >
                {t('onboarding.account.terms', { defaultValue: 'Terms' })}
              </button>
            </div>
          </motion.div>
        ) : workspaceState.status === 'loading' ? (
          <motion.div
            key="workspaces-loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
          >
            <StatusRingOrCheck phase="waiting" reducedMotion={reducedMotion} />
            <span {...stylex.props(styles.subtitle)}>
              {t('onboarding.account.loadingWorkspaces', {
                defaultValue: 'Loading your workspace…',
              })}
            </span>
          </motion.div>
        ) : workspaceState.status === 'error' ? (
          <motion.div
            key="workspaces-error"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            {...stylex.props(styles.workspaceBox)}
          >
            <p {...stylex.props(styles.errorText)} role="alert">
              {workspaceState.message ||
                t('onboarding.account.workspaceLoadFailed', {
                  defaultValue: 'Could not load workspaces.',
                })}
            </p>
            {platform.workspaces.retry ? (
              <div>
                <button
                  type="button"
                  onClick={() => void platform.workspaces.retry?.()}
                  {...stylex.props(flatSurface.primaryPill)}
                >
                  <RefreshCw size={13} aria-hidden="true" />
                  <span>{t('common.retry', { defaultValue: 'Retry' })}</span>
                </button>
              </div>
            ) : null}
          </motion.div>
        ) : creatingWorkspace ? (
          <motion.div
            key="workspace-create"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={heightTransition(reducedMotion)}
            {...stylex.props(styles.createForm)}
          >
            <input
              type="text"
              autoFocus
              data-testid="onboarding-workspace-name-input"
              value={newWorkspaceName}
              placeholder={t('onboarding.account.workspaceNamePlaceholder', {
                defaultValue: 'Workspace name',
              })}
              onChange={(e) => setNewWorkspaceName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newWorkspaceName.trim()) {
                  e.preventDefault();
                  void handleCreateWorkspace();
                }
              }}
              {...stylex.props(flatSurface.flatInput)}
            />
            {workspaceError ? (
              <p {...stylex.props(styles.errorText)} role="alert">
                {workspaceError}
              </p>
            ) : null}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              {workspaces.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setCreatingWorkspace(false)}
                  {...stylex.props(flatSurface.quietButton)}
                >
                  {t('common.cancel', { defaultValue: 'Cancel' })}
                </button>
              ) : null}
              <button
                type="button"
                disabled={!newWorkspaceName.trim() || activating}
                data-testid="onboarding-workspace-create-submit"
                onClick={() => void handleCreateWorkspace()}
                {...stylex.props(flatSurface.primaryPill)}
              >
                {activating ? (
                  <StatusRingOrCheck phase="waiting" reducedMotion={reducedMotion} />
                ) : null}
                <span>{t('common.continue', { defaultValue: 'Continue' })}</span>
              </button>
            </div>
          </motion.div>
        ) : showWorkspaceList ? (
          <motion.div
            key="workspace-list"
            layout={!reducedMotion}
            layoutId={reducedMotion ? undefined : ACCOUNT_CHIP_LAYOUT_ID}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={heightTransition(reducedMotion)}
            {...stylex.props(styles.workspaceBox)}
          >
            <div
              role="listbox"
              aria-label={t('onboarding.account.workspaceTitle', {
                defaultValue: 'Choose a workspace',
              })}
              {...stylex.props(styles.workspaceList)}
            >
              {workspaces.map((ws, idx) => {
                const active = idx === highlightedIndex;
                return (
                  <motion.button
                    key={ws.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-testid={`onboarding-workspace-option-${ws.slug || ws.id}`}
                    initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 5 }}
                    animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
                    transition={{
                      duration: reducedMotion ? 0.1 : 0.2,
                      delay: staggerDelay(idx, reducedMotion),
                    }}
                    onMouseEnter={() => setHighlightedIndex(idx)}
                    onClick={() => void activateAndFinish(ws)}
                    {...stylex.props(
                      styles.workspaceItem,
                      active && styles.workspaceItemActive
                    )}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span>{ws.name}</span>
                      {ws.encrypted ? <EncryptedWorkspaceMark /> : null}
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      {ws.slug ? (
                        <span {...stylex.props(styles.workspaceItemMeta)}>/{ws.slug}</span>
                      ) : null}
                      {active ? <Check size={14} strokeWidth={2.2} aria-hidden="true" /> : null}
                    </span>
                  </motion.button>
                );
              })}
            </div>

            {workspaceError ? (
              <p {...stylex.props(styles.errorText)} role="alert">
                {workspaceError}
              </p>
            ) : null}

            {platform.workspaces.create ? (
              <div>
                <button
                  type="button"
                  onClick={() => {
                    setNewWorkspaceName('');
                    setCreatingWorkspace(true);
                  }}
                  {...stylex.props(flatSurface.quietButton)}
                >
                  <Plus size={13} aria-hidden="true" />
                  <span>
                    {t('onboarding.account.newWorkspace', { defaultValue: 'New workspace' })}
                  </span>
                </button>
              </div>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
