import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { motion, useReducedMotion, type Variants } from 'framer-motion';
import { ArrowLeft, ArrowRight, Github, Mail } from 'lucide-react';
import { MajesticonsExternalLinkLine } from '@lody/ui';
import * as stylex from '@stylexjs/stylex';
import { Badge } from '@lody/ui/badge';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space } from '@lody/ui/tokens/scales.stylex';
import { usePostHog } from '@posthog/react';
import { useAtomValue, useSetAtom } from 'jotai';
import isEmail from 'validator/lib/isEmail';
import {
  electronLoginErrorAtom,
  electronLoginErrorDetailAtom,
  electronLoginPhaseAtom,
  nativeSignInInProgressAtom,
} from '@/atoms';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Field as UiField } from '@lody/ui/field';
import { PasswordInput } from '@lody/ui/password-input';
import { isDevEmailPasswordLoginEnabled } from '@lody/shared/electron-ipc';
import { setLoginHintCookie } from '@/lib/login-hint-cookie';
import { readLastLoginMethod, writeLastLoginMethod } from '@/lib/last-login-method';
import { LoginDitherVisual } from '@/components/login-dither-visual';
import { LoginExpandingRow, LoginViewSlot } from '@/components/login-view-slot';
import { formatPasswordValidationFailure, validateNewPassword } from '@/lib/password-validation';
import { BootShell } from '@/components/boot-shell';
import { LoadingPlaceholder } from '@/components/loading-placeholder';
import { useStableSession } from '@/hooks/useStableSession';
import { hasUsableSessionUser } from '@/hooks/stable-session-state';
import {
  buildElectronRedirectUrl,
  buildElectronWebLoginCallbackUrl,
  clearElectronAuthorizationCode,
  type ElectronOAuthQuery,
  readElectronAuthorizationCode,
  redirectToElectronDeepLink,
} from '@/lib/electron-oauth';
import { signOutWithoutRedirect } from '@/lib/auth';
import { useAuthClient } from '../providers/convex-provider';
import {
  getAppCurrentPathWithSearch,
  getAppOriginForUrlParsing,
  getAppWindowSearchParams,
  replaceAppWindowLocation,
} from '@/lib/app-location';
import { isSafeAuthRedirect } from '@/lib/auth-redirect';
import { openExternalUrl } from '@/lib/native-browser';
import { scheduleIdleTask } from '@/lib/idle-task';
import { preloadMainLayout } from '@/components/preloaded-main-layout';
import { runNativeOAuthSignIn } from '@/lib/native-oauth';
import { syncNativeAuthSession } from '@/lib/native-auth-session-sync';
import { isNativeAppShell } from '@/lib/native-platform';
import { isElectronRenderer as isElectronRendererRuntime } from '@/lib/electron';
import { WindowDragStrip } from '@/ui/window-drag-region';
import { getAuthResponseError } from '@/lib/auth-response';
import { buildEmailVerificationCallbackUrl } from '@/lib/email-verification-callback';
import { buildEmailSignInInput } from '@/lib/email-sign-in';
import {
  capturePostHogEvent,
  capturePostHogOutcome,
  detectAppDeviceClass,
  detectAppLaunchMode,
  getAppLaunchPerformanceProperties,
} from '@/lib/posthog-analytics';
import { identifyPostHogUser } from '@/lib/posthog-identity';
import { cn } from '@/lib/utils';

const LEGAL_LINK_FALLBACK_ORIGIN = 'https://lody.ai';
const ELECTRON_OAUTH_DEBUG_PREFIX = '[electron-oauth-debug]';

type SocialProvider = 'github' | 'google' | 'apple' | 'discord';
type EmailAuthMode = 'sign-in' | 'sign-up';
type EmailAuthStatus = 'idle' | 'verification-sent' | 'unverified';
type LoginView = 'oauth' | 'email';

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';
const DARK = '@media (prefers-color-scheme: dark)';

// Entrance: the column's parts rise in one after another while the visual
// develops, so the page does not arrive all at once.
const ENTRANCE_EASE = [0.22, 1, 0.36, 1] as const;
const ENTRANCE_STAGGER: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.07, delayChildren: 0.15 } },
};
const ENTRANCE_ITEM: Variants = {
  hidden: { opacity: 0, y: 10 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.5, ease: ENTRANCE_EASE } },
};
const normalizeBasePath = () => {
  const baseUrl = import.meta.env.BASE_URL || '/';
  return baseUrl === '/' || baseUrl === './' || baseUrl === '.' ? '' : baseUrl.replace(/\/$/, '');
};

const getLoginPathname = () => `${normalizeBasePath()}/login`;
const getEmailVerifiedPathname = () => `${normalizeBasePath()}/email-verified`;

const buildAppPathWithSearch = (path: string, search: URLSearchParams) => {
  const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
  const query = search.toString();
  return `${normalizeBasePath()}/${normalizedPath}${query ? `?${query}` : ''}`;
};

const getRedirectTarget = () => {
  const appOrigin = getAppOriginForUrlParsing();
  const redirectParam = getAppWindowSearchParams().get('redirect');
  const safe = isSafeAuthRedirect(redirectParam, {
    appOrigin,
    forbiddenSamePathname: getLoginPathname(),
  });
  return safe ?? (normalizeBasePath() || '/');
};

const getWebLoginCallbackURL = () => {
  const search = new URLSearchParams();
  search.set('redirect', getRedirectTarget());
  return buildAppPathWithSearch('/login', search);
};

const getElectronOAuthQuery = () => {
  if (typeof window === 'undefined') {
    return undefined;
  }

  const urlParams = getAppWindowSearchParams();
  const clientId = urlParams.get('client_id');
  const state = urlParams.get('state');
  const codeChallenge = urlParams.get('code_challenge');
  const desktopChannel = urlParams.get('desktop_channel');
  if (desktopChannel !== null && desktopChannel !== 'stable' && desktopChannel !== 'nightly') {
    return undefined;
  }
  if (clientId !== 'electron' || !state || !codeChallenge) {
    return undefined;
  }

  const query: ElectronOAuthQuery = {
    client_id: clientId,
    state,
    code_challenge: codeChallenge,
    ...(desktopChannel ? { desktop_channel: desktopChannel } : {}),
  };
  const codeChallengeMethod = urlParams.get('code_challenge_method');
  if (codeChallengeMethod) {
    query.code_challenge_method = codeChallengeMethod;
  }
  return query;
};

const getEmailAuthCallbackURL = (electronOAuthQuery: ElectronOAuthQuery | undefined) => {
  return electronOAuthQuery
    ? buildElectronWebLoginCallbackUrl(electronOAuthQuery)
    : getRedirectTarget();
};

const getConfiguredSiteUrl = (): string | null => {
  const configuredSiteUrl = import.meta.env.VITE_SITE_URL?.trim();
  if (!configuredSiteUrl) {
    return null;
  }

  try {
    return new URL(configuredSiteUrl).toString();
  } catch {
    return null;
  }
};

const getEmailVerificationCallbackBaseUrl = () => {
  const configuredSiteUrl = getConfiguredSiteUrl();
  if (configuredSiteUrl) {
    return configuredSiteUrl;
  }

  if (typeof window === 'undefined') {
    return LEGAL_LINK_FALLBACK_ORIGIN;
  }

  if (isNativeAppShell()) {
    return LEGAL_LINK_FALLBACK_ORIGIN;
  }

  if (window.location.protocol === 'file:' || window.location.origin === 'null') {
    return LEGAL_LINK_FALLBACK_ORIGIN;
  }

  return window.location.origin;
};

// Builds the URL that better-auth bakes into verification emails. On a clean
// verify the user lands on `/email-verified`, which confirms success and then
// forwards to the email sign-in view after a short countdown. On failure
// better-auth appends `&error=<code>` (TOKEN_EXPIRED, INVALID_TOKEN, etc.) to
// the same URL; `/email-verified` forwards those straight to /login so the
// error surfaces inline instead of flashing a false success screen.
const buildEmailVerificationCallbackURL = (
  targetEmail: string,
  electronOAuthQuery: ElectronOAuthQuery | undefined
) => {
  // Verification links are opened by mail clients. Rejected: relative callbacks
  // like `./email-verified` or `/email-verified`, because they resolve against
  // the Convex auth origin instead of the public app / mobile Universal Link host.
  return buildEmailVerificationCallbackUrl({
    callbackBaseUrl: getEmailVerificationCallbackBaseUrl(),
    callbackPathname: getEmailVerifiedPathname(),
    targetEmail,
    sourceSearchParams: getAppWindowSearchParams(),
    appOrigin: getAppOriginForUrlParsing(),
    loginPathname: getLoginPathname(),
    electronOAuthQuery,
  });
};

// better-auth always appends `?error=<code>` directly to the callbackURL on a
// failed verify. Old verification emails (before we owned the callback) used
// `/` as the callback, so the user can also arrive at `/login?redirect=/?error=…`
// — read the nested error too so those legacy links still surface a message.
const extractEmailErrorCode = (): string | null => {
  const params = getAppWindowSearchParams();
  const directError = params.get('error');
  if (directError) return directError;
  const redirect = params.get('redirect');
  if (!redirect) return null;
  try {
    const base = getAppOriginForUrlParsing() ?? 'http://localhost';
    return new URL(redirect, base).searchParams.get('error');
  } catch {
    return null;
  }
};

const VERIFICATION_ERROR_KEYS: Record<string, { key: string; fallback: string }> = {
  TOKEN_EXPIRED: {
    key: 'login.verificationErrorExpired',
    fallback: 'This verification link has expired. Sign in to request a new one.',
  },
  INVALID_TOKEN: {
    key: 'login.verificationErrorInvalid',
    fallback: 'This verification link is invalid or has already been used.',
  },
  USER_NOT_FOUND: {
    key: 'login.verificationErrorUserNotFound',
    fallback: 'We could not find an account for this verification link.',
  },
  INVALID_USER: {
    key: 'login.verificationErrorMismatch',
    fallback: "This link doesn't match the current user.",
  },
};

// OAuth is a full-page redirect away from the app, so success cannot be observed
// inline in handleSocialLogin. We stash a short-lived marker before redirecting
// and read it back when the provider returns the user to /login with a session.
// Rejected firing oauth_succeeded purely on `hasRawUser`: that would also fire
// when an already-signed-in user merely revisits /login (no OAuth round-trip).
const OAUTH_PENDING_STORAGE_KEY = 'lody.auth.oauth_pending';
const OAUTH_PENDING_MAX_AGE_MS = 10 * 60 * 1000;
// Heuristic only — the authoritative is_new_user comes from better-auth on the
// server (spec §3.5). Treat accounts created within this window as new signups.
const OAUTH_NEW_USER_WINDOW_MS = 2 * 60 * 1000;

type PendingOAuth = {
  provider: SocialProvider;
  login_surface: string;
  started_at_ms: number;
};

function writePendingOAuth(marker: PendingOAuth): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.sessionStorage?.setItem(OAUTH_PENDING_STORAGE_KEY, JSON.stringify(marker));
  } catch {
    // sessionStorage can be unavailable (private mode / sandboxed iframe); the
    // marker is best-effort and oauth_succeeded simply degrades to not firing.
  }
}

function readAndClearPendingOAuth(): PendingOAuth | null {
  if (typeof window === 'undefined') {
    return null;
  }
  let raw: string | null = null;
  try {
    raw = window.sessionStorage?.getItem(OAUTH_PENDING_STORAGE_KEY) ?? null;
    window.sessionStorage?.removeItem(OAUTH_PENDING_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as PendingOAuth).provider !== 'string' ||
      typeof (parsed as PendingOAuth).started_at_ms !== 'number'
    ) {
      return null;
    }
    const marker = parsed as PendingOAuth;
    if (Date.now() - marker.started_at_ms > OAUTH_PENDING_MAX_AGE_MS) {
      return null;
    }
    return marker;
  } catch {
    return null;
  }
}

type SessionUserWithCreatedAt = { id?: string; createdAt?: string | number | Date };

function inferIsNewUser(sessionUser: unknown): boolean | null {
  if (!sessionUser || typeof sessionUser !== 'object') {
    return null;
  }
  const createdAt = (sessionUser as SessionUserWithCreatedAt).createdAt;
  if (createdAt == null) {
    return null;
  }
  const createdAtMs = new Date(createdAt).getTime();
  if (!Number.isFinite(createdAtMs)) {
    return null;
  }
  return Date.now() - createdAtMs <= OAUTH_NEW_USER_WINDOW_MS;
}

function logElectronOAuthDebug(message: string, meta?: Record<string, unknown>): void {
  if (meta) {
    console.info(ELECTRON_OAUTH_DEBUG_PREFIX, message, meta);
    return;
  }
  console.info(ELECTRON_OAUTH_DEBUG_PREFIX, message);
}

type AuthClientWithElectronTransfer = ReturnType<typeof useAuthClient> & {
  electron?: {
    transferUser?: (options?: {
      fetchOptions?: {
        query?: Record<string, string>;
      };
    }) => Promise<{
      data?: {
        electron_authorization_code?: string | null;
      };
    }>;
  };
};

type AuthClientWithElectronBrowserSignIn = ReturnType<typeof useAuthClient> & {
  signIn: {
    social: (options?: { callbackURL?: string }) => Promise<unknown>;
  };
};

type AuthClientWithEmailPassword = ReturnType<typeof useAuthClient> & {
  signIn: ReturnType<typeof useAuthClient>['signIn'] & {
    email: (input: {
      email: string;
      password: string;
      rememberMe?: boolean;
      callbackURL?: string;
    }) => Promise<unknown>;
  };
  signUp: {
    email: (input: { name: string; email: string; password: string }) => Promise<unknown>;
  };
  sendVerificationEmail: (input: { email: string; callbackURL?: string }) => Promise<unknown>;
};

const getLegalLinksOrigin = () => {
  if (typeof window === 'undefined') {
    return LEGAL_LINK_FALLBACK_ORIGIN;
  }

  if (isNativeAppShell()) {
    return LEGAL_LINK_FALLBACK_ORIGIN;
  }

  if (window.location.protocol === 'file:' || window.location.origin === 'null') {
    return LEGAL_LINK_FALLBACK_ORIGIN;
  }

  return window.location.origin;
};

function BrowserRedirect({
  to,
  navigate,
  beforeNavigate,
}: {
  to: string;
  navigate: (path: string) => void;
  beforeNavigate?: () => Promise<boolean> | boolean;
}) {
  useEffect(() => {
    let cancelled = false;
    if (typeof window !== 'undefined') {
      const redirect = async () => {
        const shouldNavigate = beforeNavigate ? await beforeNavigate() : true;
        if (!cancelled && shouldNavigate) {
          navigate(to);
        }
      };

      void redirect();
    }

    return () => {
      cancelled = true;
    };
  }, [beforeNavigate, navigate, to]);

  return <BootShell path={to} />;
}

function ProviderIcon({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'flex h-[18px] w-[18px] shrink-0 items-center justify-center [&_svg]:size-[18px]!',
        className
      )}
    >
      {children}
    </span>
  );
}

function GoogleIcon() {
  return (
    <ProviderIcon>
      <svg
        aria-hidden="true"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="-0.5 0 48 48"
        preserveAspectRatio="xMidYMid"
      >
        <path
          d="M9.82727273 24C9.82727273 22.4757333 10.0804318 21.0144 10.5322727 19.6437333L2.62345455 13.6042667C1.08206818 16.7338667 0.213636364 20.2602667 0.213636364 24C0.213636364 27.7365333 1.081 31.2608 2.62025 34.3882667L10.5247955 28.3370667C10.0772273 26.9728 9.82727273 25.5168 9.82727273 24"
          fill="currentColor"
        />
        <path
          d="M23.7136364 10.1333333C27.025 10.1333333 30.0159091 11.3066667 32.3659091 13.2266667L39.2022727 6.4C35.0363636 2.77333333 29.6954545 0.533333333 23.7136364 0.533333333C14.4268636 0.533333333 6.44540909 5.84426667 2.62345455 13.6042667L10.5322727 19.6437333C12.3545909 14.112 17.5491591 10.1333333 23.7136364 10.1333333"
          fill="currentColor"
        />
        <path
          d="M23.7136364 37.8666667C17.5491591 37.8666667 12.3545909 33.888 10.5322727 28.3562667L2.62345455 34.3946667C6.44540909 42.1557333 14.4268636 47.4666667 23.7136364 47.4666667C29.4455 47.4666667 34.9177955 45.4314667 39.0249545 41.6181333L31.5177727 35.8144C29.3995682 37.1488 26.7323182 37.8666667 23.7136364 37.8666667"
          fill="currentColor"
        />
        <path
          d="M46.1454545 24C46.1454545 22.6133333 45.9318182 21.12 45.6113636 19.7333333L23.7136364 19.7333333L23.7136364 28.8L36.3181818 28.8C35.6879545 31.8912 33.9724545 34.2677333 31.5177727 35.8144L39.0249545 41.6181333C43.3393409 37.6138667 46.1454545 31.6490667 46.1454545 24"
          fill="currentColor"
        />
      </svg>
    </ProviderIcon>
  );
}

function AppleIcon() {
  return (
    <ProviderIcon>
      <svg
        fill="currentColor"
        viewBox="-52.01 0 560.035 560.035"
        xmlns="http://www.w3.org/2000/svg"
      >
        <g id="SVGRepo_bgCarrier" strokeWidth="0"></g>
        <g id="SVGRepo_tracerCarrier" strokeLinecap="round" strokeLinejoin="round"></g>
        <g id="SVGRepo_iconCarrier">
          <path d="M380.844 297.529c.787 84.752 74.349 112.955 75.164 113.314-.622 1.988-11.754 40.191-38.756 79.652-23.343 34.117-47.568 68.107-85.731 68.811-37.499.691-49.557-22.236-92.429-22.236-42.859 0-56.256 21.533-91.753 22.928-36.837 1.395-64.889-36.891-88.424-70.883-48.093-69.53-84.846-196.475-35.496-282.165 24.516-42.554 68.328-69.501 115.882-70.192 36.173-.69 70.315 24.336 92.429 24.336 22.1 0 63.59-30.096 107.208-25.676 18.26.76 69.517 7.376 102.429 55.552-2.652 1.644-61.159 35.704-60.523 106.559M310.369 89.418C329.926 65.745 343.089 32.79 339.498 0 311.308 1.133 277.22 18.785 257 42.445c-18.121 20.952-33.991 54.487-29.709 86.628 31.421 2.431 63.52-15.967 83.078-39.655"></path>
        </g>
      </svg>
    </ProviderIcon>
  );
}

function DiscordIcon() {
  return (
    <ProviderIcon>
      <svg
        aria-hidden="true"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 -28.5 256 256"
        preserveAspectRatio="xMidYMid"
        fill="currentColor"
      >
        <path
          d="M216.856339 16.5966031C200.285002 8.84328665 182.566144 3.2084988 164.041564 0C161.766523 4.11318106 159.108624 9.64549908 157.276099 14.0464379C137.583995 11.0849896 118.072967 11.0849896 98.7430163 14.0464379C96.9108417 9.64549908 94.1925838 4.11318106 91.8971895 0C73.3526068 3.2084988 55.6133949 8.86399117 39.0420583 16.6376612C5.61752293 67.146514 -3.4433191 116.400813 1.08711069 164.955721C23.2560196 181.510915 44.7403634 191.567697 65.8621325 198.148576C71.0772151 190.971126 75.7283628 183.341335 79.7352139 175.300261C72.104019 172.400575 64.7949724 168.822202 57.8887866 164.667963C59.7209612 163.310589 61.5131304 161.891452 63.2445898 160.431257C105.36741 180.133187 151.134928 180.133187 192.754523 160.431257C194.506336 161.891452 196.298154 163.310589 198.110326 164.667963C191.183787 168.842556 183.854737 172.420929 176.223542 175.320965C180.230393 183.341335 184.861538 190.991831 190.096624 198.16893C211.238746 191.588051 232.743023 181.531619 254.911949 164.955721C260.227747 108.668201 245.831087 59.8662432 216.856339 16.5966031ZM85.4738752 135.09489C72.8290281 135.09489 62.4592217 123.290155 62.4592217 108.914901C62.4592217 94.5396472 72.607595 82.7145587 85.4738752 82.7145587C98.3405064 82.7145587 108.709962 94.5189427 108.488529 108.914901C108.508531 123.290155 98.3405064 135.09489 85.4738752 135.09489ZM170.525237 135.09489C157.88039 135.09489 147.510584 123.290155 147.510584 108.914901C147.510584 94.5396472 157.658606 82.7145587 170.525237 82.7145587C183.391518 82.7145587 193.761324 94.5189427 193.539891 108.914901C193.539891 123.290155 183.391518 135.09489 170.525237 135.09489Z"
          fillRule="nonzero"
        />
      </svg>
    </ProviderIcon>
  );
}

function GitHubIcon() {
  return (
    <ProviderIcon>
      <Github />
    </ProviderIcon>
  );
}

const PROVIDER_CONFIG: {
  id: SocialProvider;
  icon: React.ComponentType;
  labelKey: string;
  labelDefault: string;
}[] = [
  {
    id: 'github',
    icon: GitHubIcon,
    labelKey: 'login.githubSignIn',
    labelDefault: 'Continue with GitHub',
  },
  {
    id: 'google',
    icon: GoogleIcon,
    labelKey: 'login.googleSignIn',
    labelDefault: 'Continue with Google',
  },
  {
    id: 'apple',
    icon: AppleIcon,
    labelKey: 'login.appleSignIn',
    labelDefault: 'Continue with Apple',
  },
  {
    id: 'discord',
    icon: DiscordIcon,
    labelKey: 'login.discordSignIn',
    labelDefault: 'Continue with Discord',
  },
];

function SocialLoginButtonContent({
  icon,
  label,
  width,
}: {
  icon: React.ReactNode;
  label: string;
  width: number | null;
}) {
  return (
    <span
      className="mx-auto grid grid-cols-[18px_minmax(0,1fr)] items-center gap-2 whitespace-nowrap"
      style={width ? { width: `${width}px` } : undefined}
    >
      {icon}
      <span>{label}</span>
    </span>
  );
}

export type LoginPageProps = {
  replaceLocation?: (path: string) => void;
  isElectronRenderer?: boolean;
};

export function LoginPage({
  replaceLocation = replaceAppWindowLocation,
  isElectronRenderer: isElectronRendererOverride,
}: LoginPageProps = {}) {
  const { t, i18n } = useTranslation();
  const authClient = useAuthClient();
  const postHog = usePostHog();
  const verificationErrorCode = extractEmailErrorCode();
  const verificationErrorMessage = (() => {
    if (!verificationErrorCode) return '';
    const mapping = VERIFICATION_ERROR_KEYS[verificationErrorCode];
    if (mapping) return t(mapping.key, mapping.fallback);
    return t('login.verificationErrorGeneric', 'Verification failed. Please sign in to try again.');
  })();
  const [error, setError] = useState(verificationErrorMessage);
  const [loadingProvider, setLoadingProvider] = useState<SocialProvider | null>(null);
  const [view, setView] = useState<LoginView>(() => {
    const viewParam = getAppWindowSearchParams().get('view');
    if (viewParam === 'email' || verificationErrorCode) return 'email';
    return 'oauth';
  });
  const [emailAuthMode, setEmailAuthMode] = useState<EmailAuthMode>('sign-in');
  const [emailAuthStatus, setEmailAuthStatus] = useState<EmailAuthStatus>('idle');
  const [emailName, setEmailName] = useState('');
  const [email, setEmail] = useState(() => getAppWindowSearchParams().get('email') ?? '');
  const [password, setPassword] = useState('');
  const [isEmailSubmitting, setIsEmailSubmitting] = useState(false);
  const [isResendingVerification, setIsResendingVerification] = useState(false);
  const [isOpeningElectronBrowser, setIsOpeningElectronBrowser] = useState(false);
  // Browser-side desktop handoff (`/login?client_id=electron&…`). The page never
  // bridges the browser session on its own: signing out of the desktop leaves
  // this browser signed in as the previous account, so an automatic transfer
  // would mint an authorization code for the account the user is trying to
  // leave, with no way back. The user picks the account, then this holds the
  // channel-specific auth callback URL that both the automatic navigation and
  // the visible fallback link use.
  const [electronHandoffUrl, setElectronHandoffUrl] = useState<string | null>(null);
  const [isPreparingElectronHandoff, setIsPreparingElectronHandoff] = useState(false);
  const [isSwitchingElectronAccount, setIsSwitchingElectronAccount] = useState(false);
  // A sign-out that did not reach the server leaves this browser authenticated
  // as the account the user asked to leave, and the session cookie is exactly
  // what the next transfer would hand to the desktop app. Block the handoff
  // until a switch succeeds (or the session goes away on its own) rather than
  // silently offering the old account again.
  const [hasFailedElectronAccountSwitch, setHasFailedElectronAccountSwitch] = useState(false);
  // Bumped when the user chooses another account. A transfer started for the
  // previous account can still be in flight (or its `better-auth.electron`
  // cookie still set), and must not produce a handoff link afterwards.
  const electronAccountGenerationRef = useRef(0);
  const autoOpenedElectronHandoffRef = useRef<string | null>(null);
  // Main owns the callback exchange; restored snapshots also recover progress
  // when this renderer mounts after the browser has returned.
  const electronLoginPhase = useAtomValue(electronLoginPhaseAtom);
  const electronLoginError = useAtomValue(electronLoginErrorAtom);
  const electronLoginErrorDetail = useAtomValue(electronLoginErrorDetailAtom);
  const isCompletingElectronSignIn = electronLoginPhase === 'exchanging';
  const setNativeSignInInProgress = useSetAtom(nativeSignInInProgressAtom);
  const [lastLoginMethod] = useState(readLastLoginMethod);
  const prefersReducedMotion = useReducedMotion();
  const taglineRef = useRef<HTMLParagraphElement | null>(null);
  const emailInputRef = useRef<HTMLInputElement | null>(null);
  const focusEmailInput = useCallback(() => {
    emailInputRef.current?.focus({ preventScroll: true });
  }, []);
  const loginViewedRef = useRef(false);
  const electronOAuthQuery = getElectronOAuthQuery();
  const isElectronOAuthFlow = electronOAuthQuery != null;
  const isElectronRenderer = isElectronRendererOverride ?? isElectronRendererRuntime();
  const isElectronRendererLogin = isElectronRenderer && !isElectronOAuthFlow;
  const isDevElectronEmailPasswordLoginEnabled = isDevEmailPasswordLoginEnabled({
    isPackaged: !import.meta.env.DEV,
  });
  const canUseEmailPasswordLogin =
    !isElectronRendererLogin || isDevElectronEmailPasswordLoginEnabled;
  const isChinese = i18n.resolvedLanguage?.startsWith('zh') ?? false;
  const legalLinksOrigin = getLegalLinksOrigin();
  const termsUrl = new URL(isChinese ? '/zh/terms' : '/terms', legalLinksOrigin).toString();
  const privacyUrl = new URL(isChinese ? '/zh/privacy' : '/privacy', legalLinksOrigin).toString();
  const emailAuthCallbackURL = getEmailAuthCallbackURL(electronOAuthQuery);
  const isNativeApp = isNativeAppShell();
  const {
    data: session,
    hasLocalToken,
    hasRawUser,
    isPending,
    isRetrying,
    error: sessionError,
    confirmedUnauthenticated,
  } = useStableSession();
  const canRedirectAuthenticatedUser = hasUsableSessionUser({
    hasRawUser,
    isRetrying,
    hasError: sessionError !== null,
    confirmedUnauthenticated,
  });
  const loginSurface = isElectronOAuthFlow
    ? 'electron_browser_callback'
    : isNativeApp
      ? 'native_app'
      : isElectronRenderer
        ? 'electron_renderer'
        : 'web';
  const expiredMessage =
    getAppWindowSearchParams().get('expired') === '1'
      ? t('login.sessionExpired', 'Login expired. Please sign in again.')
      : '';
  const desktopLoginError =
    isElectronRendererLogin && electronLoginError
      ? t(`login.desktopErrors.${electronLoginError}`)
      : '';
  const effectiveError = error || desktopLoginError || expiredMessage;
  // The category message says what to do; the detail is what support needs.
  const effectiveErrorDetail =
    !error && desktopLoginError && electronLoginErrorDetail
      ? t('login.desktopErrors.detail', { detail: electronLoginErrorDetail })
      : '';
  const isAnyLoading =
    loadingProvider !== null ||
    isEmailSubmitting ||
    isResendingVerification ||
    isOpeningElectronBrowser ||
    isPreparingElectronHandoff ||
    isSwitchingElectronAccount;
  // The browser page opened by the desktop app shows which account it would
  // hand over before handing anything over.
  const isElectronBrowserHandoff = isElectronOAuthFlow && canRedirectAuthenticatedUser;
  const electronHandoffAccountLabel = (() => {
    const user = session?.user as { email?: unknown; name?: unknown } | undefined;
    if (typeof user?.email === 'string' && user.email.length > 0) {
      return user.email;
    }
    if (typeof user?.name === 'string' && user.name.length > 0) {
      return user.name;
    }
    return '';
  })();
  const isButtonsDisabled = isAnyLoading || (hasLocalToken && (isPending || isRetrying));
  const providerCount = isElectronRendererLogin ? 1 : PROVIDER_CONFIG.length;
  const getProviderLabel = (provider: SocialProvider) => {
    const config = PROVIDER_CONFIG.find((c) => c.id === provider);
    if (!config) return '';
    return loadingProvider === provider
      ? t('login.loading')
      : t(config.labelKey, config.labelDefault);
  };

  const emailEntryLabel = t('login.continueWithEmail', 'Continue with email');

  // Warm the workspace layout while this page waits on the user, so the
  // post-sign-in route swap neither fetches nor suspends. `preloadMainLayout`,
  // not a bare `import()`: it records the module, so `PreloadedMainLayout`
  // mounts it directly instead of suspending into the boot shell for a commit.
  // Idle-scheduled so it never competes with this page's own paint; a failure
  // is swallowed because it is only a warm-up, and is not cached, so the real
  // mount retries and surfaces its own error.
  //
  // The cost is explicit: on web and mobile this is a real network request that
  // /login did not use to make, and a visitor who never signs in pays it too.
  // It is deliberately NOT gated on a sign-in click — a social login navigates
  // away immediately, so a fetch started at click time is usually discarded,
  // and the whole point is to have the chunk before the redirect returns.
  useEffect(() => scheduleIdleTask(() => void preloadMainLayout().catch(() => {})), []);

  useEffect(() => {
    if (loginViewedRef.current) {
      return;
    }
    loginViewedRef.current = true;
    capturePostHogEvent(postHog, 'auth/login_viewed', {
      login_surface: loginSurface,
      launch_mode: detectAppLaunchMode(isElectronRenderer),
      device_class: detectAppDeviceClass(),
      has_local_token: hasLocalToken,
      has_raw_user: hasRawUser,
      expired: Boolean(expiredMessage),
      provider_count: providerCount,
      ...getAppLaunchPerformanceProperties(),
    });
  }, [
    expiredMessage,
    hasLocalToken,
    hasRawUser,
    isElectronRenderer,
    loginSurface,
    postHog,
    providerCount,
  ]);

  // When a social-OAuth round-trip returns the user to /login with a session,
  // resolve the pending marker into a single oauth_succeeded event and identify
  // the now-authenticated user (spec §4.2/§4.3). is_new_user is a best-effort
  // client signal; the authoritative value comes from better-auth (spec §3.5).
  const oauthSucceededFiredRef = useRef(false);
  useEffect(() => {
    if (!canRedirectAuthenticatedUser || oauthSucceededFiredRef.current) {
      return;
    }
    const pending = readAndClearPendingOAuth();
    if (!pending) {
      return;
    }
    oauthSucceededFiredRef.current = true;
    writeLastLoginMethod(pending.provider);
    const sessionUser = session?.user;
    identifyPostHogUser(
      postHog,
      sessionUser && typeof sessionUser.id === 'string' ? sessionUser.id : undefined
    );
    capturePostHogOutcome(postHog, 'auth/oauth_returned', 'success', {
      provider: pending.provider,
      login_surface: pending.login_surface,
      launch_mode: detectAppLaunchMode(isElectronRenderer),
      device_class: detectAppDeviceClass(),
      is_new_user: inferIsNewUser(sessionUser),
      oauth_round_trip_ms: Date.now() - pending.started_at_ms,
    });
  }, [canRedirectAuthenticatedUser, isElectronRenderer, postHog, session]);

  const handleEnterEmailView = useCallback(() => {
    setError('');
    setEmailAuthStatus('idle');
    setView('email');
    capturePostHogEvent(postHog, 'auth/email_view_opened', {
      login_surface: loginSurface,
      launch_mode: detectAppLaunchMode(isElectronRenderer),
      device_class: detectAppDeviceClass(),
    });
  }, [isElectronRenderer, loginSurface, postHog]);

  const handleExitEmailView = useCallback(() => {
    setError('');
    setEmailAuthStatus('idle');
    setView('oauth');
  }, []);

  const syncNativeSessionBeforeRedirect = useCallback(async () => {
    if (!isNativeApp) {
      return true;
    }

    const tokenPersisted = await syncNativeAuthSession({
      initialResult: session,
      getSession: () => authClient.getSession(),
    });
    if (!tokenPersisted) {
      setError(t('login.loginFailed', 'Login failed. Please try again.'));
      return false;
    }
    return true;
  }, [authClient, isNativeApp, session, t]);

  const prepareAuthenticatedRedirect = useCallback(async () => {
    setLoginHintCookie(true);
    return await syncNativeSessionBeforeRedirect();
  }, [syncNativeSessionBeforeRedirect]);

  const handleToggleEmailAuthMode = useCallback(() => {
    setEmailAuthMode((current) => (current === 'sign-in' ? 'sign-up' : 'sign-in'));
    setError('');
    setEmailAuthStatus('idle');
  }, []);

  const sendVerificationEmail = useCallback(
    async (targetEmail: string) => {
      return await (authClient as AuthClientWithEmailPassword).sendVerificationEmail({
        email: targetEmail,
        callbackURL: buildEmailVerificationCallbackURL(targetEmail, electronOAuthQuery),
      });
    },
    [authClient, electronOAuthQuery]
  );

  const handleEmailSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError('');
      setEmailAuthStatus('idle');

      const trimmedEmail = email.trim();
      if (!isEmail(trimmedEmail)) {
        setError(t('login.emailInvalid', 'Please enter a valid email address.'));
        return;
      }

      // Sign-in only requires a non-empty password — we cannot reject legacy
      // passwords client-side. Sign-up applies the full strength rules.
      if (password.length === 0) {
        setError(t('login.passwordEmpty', 'Please enter your password.'));
        return;
      }

      const trimmedName = emailName.trim();
      if (emailAuthMode === 'sign-up') {
        if (trimmedName.length === 0) {
          setError(t('login.nameRequired', 'Please enter your name.'));
          return;
        }
        const passwordCheck = validateNewPassword(password);
        if (!passwordCheck.ok) {
          setError(formatPasswordValidationFailure(passwordCheck, t, 'login'));
          return;
        }
      }

      const normalizedEmail = trimmedEmail.toLowerCase();
      const emailAuthClient = authClient as AuthClientWithEmailPassword;
      setIsEmailSubmitting(true);
      const shouldFenceNativeSignIn = isNativeApp && emailAuthMode === 'sign-in';
      let keepNativeSignInFence = false;
      if (shouldFenceNativeSignIn) {
        setNativeSignInInProgress(true);
      }

      try {
        if (emailAuthMode === 'sign-in') {
          capturePostHogEvent(postHog, 'auth/email_sign_in_started', {
            login_surface: loginSurface,
            launch_mode: detectAppLaunchMode(isElectronRenderer),
            device_class: detectAppDeviceClass(),
          });
          const response = await emailAuthClient.signIn.email(
            buildEmailSignInInput({
              email: normalizedEmail,
              password,
              callbackURL: buildEmailVerificationCallbackURL(normalizedEmail, electronOAuthQuery),
              isNativeApp,
            })
          );
          const authError = getAuthResponseError(response);
          if (authError) {
            if (authError.code === 'EMAIL_NOT_VERIFIED') {
              setEmailAuthStatus('unverified');
              setError(
                t(
                  'login.emailVerificationRequired',
                  'Verify your email before signing in. Check your inbox or resend the verification link.'
                )
              );
            } else {
              setError(authError.message ?? t('login.emailLoginFailed', 'Unable to sign in.'));
            }
            capturePostHogEvent(postHog, 'auth/email_sign_in_failed', {
              login_surface: loginSurface,
              launch_mode: detectAppLaunchMode(isElectronRenderer),
              device_class: detectAppDeviceClass(),
              error_status: authError.status,
              error_code: authError.code,
            });
            return;
          }

          writeLastLoginMethod('email');
          capturePostHogEvent(postHog, 'auth/email_sign_in_succeeded', {
            login_surface: loginSurface,
            launch_mode: detectAppLaunchMode(isElectronRenderer),
            device_class: detectAppDeviceClass(),
          });
          if (isNativeApp) {
            const tokenPersisted = await syncNativeAuthSession({
              initialResult: response,
              getSession: () => authClient.getSession(),
            });
            if (!tokenPersisted) {
              setError(t('login.loginFailed', 'Login failed. Please try again.'));
              return;
            }
          }
          if (electronOAuthQuery) {
            replaceAppWindowLocation(emailAuthCallbackURL);
            keepNativeSignInFence = true;
            return;
          }
          setLoginHintCookie(true);
          replaceLocation(getRedirectTarget());
          keepNativeSignInFence = true;
          return;
        }

        capturePostHogEvent(postHog, 'auth/email_sign_up_started', {
          login_surface: loginSurface,
          launch_mode: detectAppLaunchMode(isElectronRenderer),
          device_class: detectAppDeviceClass(),
        });
        const response = await emailAuthClient.signUp.email({
          name: trimmedName,
          email: normalizedEmail,
          password,
        });
        const authError = getAuthResponseError(response);
        if (authError) {
          setError(authError.message ?? t('login.emailSignUpFailed', 'Unable to create account.'));
          capturePostHogEvent(postHog, 'auth/email_sign_up_failed', {
            login_surface: loginSurface,
            launch_mode: detectAppLaunchMode(isElectronRenderer),
            device_class: detectAppDeviceClass(),
            error_status: authError.status,
            error_code: authError.code,
          });
          return;
        }

        const verificationResponse = await sendVerificationEmail(normalizedEmail);
        const verificationError = getAuthResponseError(verificationResponse);
        if (verificationError) {
          setEmailAuthMode('sign-in');
          setEmailAuthStatus('unverified');
          setPassword('');
          setError(
            t(
              'login.emailVerificationSendFailedAfterSignUp',
              'Account created, but we could not send the verification email. Use Resend verification to try again.'
            )
          );
          capturePostHogEvent(postHog, 'auth/email_sign_up_succeeded', {
            login_surface: loginSurface,
            launch_mode: detectAppLaunchMode(isElectronRenderer),
            device_class: detectAppDeviceClass(),
            verification_email_error: true,
            verification_email_error_status: verificationError.status,
            verification_email_error_code: verificationError.code,
          });
          return;
        }

        setEmailAuthMode('sign-in');
        setEmailAuthStatus('verification-sent');
        setPassword('');
        capturePostHogEvent(postHog, 'auth/email_sign_up_succeeded', {
          login_surface: loginSurface,
          launch_mode: detectAppLaunchMode(isElectronRenderer),
          device_class: detectAppDeviceClass(),
          verification_email_error: Boolean(verificationError),
        });
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t('login.emailAuthFailed', 'Email authentication failed. Please try again.')
        );
      } finally {
        if (shouldFenceNativeSignIn && !keepNativeSignInFence) {
          setNativeSignInInProgress(false);
        }
        setIsEmailSubmitting(false);
      }
    },
    [
      authClient,
      email,
      emailAuthCallbackURL,
      emailAuthMode,
      emailName,
      electronOAuthQuery,
      isElectronRenderer,
      isNativeApp,
      loginSurface,
      password,
      postHog,
      replaceLocation,
      sendVerificationEmail,
      setNativeSignInInProgress,
      t,
    ]
  );

  const handleResendVerification = useCallback(async () => {
    setError('');
    const trimmedEmail = email.trim();
    if (!isEmail(trimmedEmail)) {
      setError(t('login.emailInvalid', 'Please enter a valid email address.'));
      return;
    }

    setIsResendingVerification(true);
    try {
      const response = await sendVerificationEmail(trimmedEmail.toLowerCase());
      const authError = getAuthResponseError(response);
      if (authError) {
        setError(
          authError.message ??
            t('login.emailVerificationResendFailed', 'Unable to resend verification email.')
        );
        return;
      }
      setEmailAuthStatus('verification-sent');
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('login.emailVerificationResendFailed', 'Unable to resend verification email.')
      );
    } finally {
      setIsResendingVerification(false);
    }
  }, [email, sendVerificationEmail, t]);

  const handleForgotPassword = useCallback(() => {
    const search = new URLSearchParams();
    search.set(
      'redirect',
      typeof window === 'undefined' ? getLoginPathname() : getAppCurrentPathWithSearch()
    );
    const trimmedEmail = email.trim();
    if (isEmail(trimmedEmail)) {
      search.set('email', trimmedEmail.toLowerCase());
    }
    replaceLocation(buildAppPathWithSearch('/forgot-password', search));
  }, [email, replaceLocation]);

  const handleSocialLogin = useCallback(
    async (provider: SocialProvider) => {
      setError('');
      setLoadingProvider(provider);
      capturePostHogEvent(postHog, 'auth/oauth_started', {
        provider,
        login_surface: loginSurface,
        launch_mode: detectAppLaunchMode(isElectronRenderer),
        device_class: detectAppDeviceClass(),
      });
      // Persist a marker so the post-redirect return can fire oauth_succeeded.
      writePendingOAuth({ provider, login_surface: loginSurface, started_at_ms: Date.now() });
      let keepNativeSignInFence = false;
      if (isNativeApp) {
        setNativeSignInInProgress(true);
      }

      try {
        if (electronOAuthQuery) {
          await authClient.signIn.social({
            provider,
            callbackURL: buildElectronWebLoginCallbackUrl(electronOAuthQuery),
          });
          return;
        }

        const callbackURL = isElectronRenderer
          ? '/login'
          : isNativeApp
            ? getRedirectTarget()
            : getWebLoginCallbackURL();
        const signIn = () =>
          authClient.signIn.social({
            provider,
            callbackURL,
          });

        if (isNativeApp) {
          const outcome = await runNativeOAuthSignIn(signIn);
          if (outcome === 'completed') {
            const tokenPersisted = await syncNativeAuthSession({
              getSession: () => authClient.getSession(),
            });
            if (!tokenPersisted) {
              setError(t('login.loginFailed', 'Login failed. Please try again.'));
              return;
            }
            // Native OAuth completes in the same page lifecycle (no full redirect),
            // so fire success here rather than relying on the post-redirect return.
            // The session atom may not be hydrated yet, so identify by the user id
            // resolved from a fresh getSession() rather than the stale React state.
            readAndClearPendingOAuth();
            writeLastLoginMethod(provider);
            const refreshedSession = await authClient.getSession().catch(() => null);
            const nativeUser =
              refreshedSession && typeof refreshedSession === 'object'
                ? (refreshedSession as { data?: { user?: unknown } }).data?.user
                : undefined;
            const nativeUserId =
              nativeUser && typeof (nativeUser as { id?: unknown }).id === 'string'
                ? (nativeUser as { id: string }).id
                : undefined;
            identifyPostHogUser(postHog, nativeUserId);
            capturePostHogOutcome(postHog, 'auth/oauth_returned', 'success', {
              provider,
              login_surface: loginSurface,
              launch_mode: detectAppLaunchMode(isElectronRenderer),
              device_class: detectAppDeviceClass(),
              is_new_user: inferIsNewUser(nativeUser),
            });
            setLoginHintCookie(true);
            replaceLocation(getRedirectTarget());
            keepNativeSignInFence = true;
          }
          return;
        }

        await signIn();
      } catch (err) {
        setError(t('login.loginFailed', 'Login failed. Please try again.'));
        // Clear the pending marker so a later sign-in does not misattribute a
        // stale failed attempt as a success on return.
        readAndClearPendingOAuth();
        capturePostHogEvent(postHog, 'auth/oauth_start_failed', {
          provider,
          login_surface: loginSurface,
          launch_mode: detectAppLaunchMode(isElectronRenderer),
          device_class: detectAppDeviceClass(),
          error_name: err instanceof Error ? err.name : typeof err,
          error_message: err instanceof Error ? err.message : String(err),
        });
        console.error(`${provider} login error:`, err);
      } finally {
        if (isNativeApp && !keepNativeSignInFence) {
          setNativeSignInInProgress(false);
        }
        setLoadingProvider(null);
      }
    },
    [
      authClient,
      electronOAuthQuery,
      isElectronRenderer,
      isNativeApp,
      loginSurface,
      postHog,
      replaceLocation,
      setNativeSignInInProgress,
      t,
    ]
  );

  const handleElectronBrowserLogin = useCallback(async () => {
    setError('');
    setIsOpeningElectronBrowser(true);
    capturePostHogEvent(postHog, 'auth/electron_browser_login_started', {
      login_surface: loginSurface,
      launch_mode: detectAppLaunchMode(isElectronRenderer),
      device_class: detectAppDeviceClass(),
    });

    try {
      await (authClient as AuthClientWithElectronBrowserSignIn).signIn.social({
        callbackURL: '/login',
      });
    } catch (err) {
      setError(t('login.loginFailed', 'Login failed. Please try again.'));
      capturePostHogEvent(postHog, 'auth/electron_browser_login_failed', {
        login_surface: loginSurface,
        launch_mode: detectAppLaunchMode(isElectronRenderer),
        device_class: detectAppDeviceClass(),
        error_name: err instanceof Error ? err.name : typeof err,
        error_message: err instanceof Error ? err.message : String(err),
      });
      console.error('Electron browser login error:', err);
    } finally {
      setIsOpeningElectronBrowser(false);
    }
  }, [authClient, isElectronRenderer, loginSurface, postHog, t]);

  const handleElectronSessionTransfer = useCallback(async () => {
    if (!electronOAuthQuery) {
      return;
    }
    if (hasFailedElectronAccountSwitch) {
      // The last switch did not sign this browser out, so a transfer here would
      // hand over the account the user tried to leave.
      return;
    }

    const transferUser = (authClient as AuthClientWithElectronTransfer).electron?.transferUser;
    if (typeof transferUser !== 'function') {
      setError(t('login.loginFailed', 'Login failed. Please try again.'));
      capturePostHogEvent(postHog, 'auth/electron_session_transfer_failed', {
        login_surface: loginSurface,
        launch_mode: detectAppLaunchMode(isElectronRenderer),
        failure_reason: 'transfer_api_unavailable',
      });
      return;
    }

    // Everything after the await belongs to the account signed in right now.
    const generation = electronAccountGenerationRef.current;
    const isCurrentAccount = () => electronAccountGenerationRef.current === generation;

    setError('');
    setElectronHandoffUrl(null);
    setIsPreparingElectronHandoff(true);
    // Drop any authorization code left in the cookie by an earlier transfer, so
    // the fallback read below can only pick up the code this call minted.
    clearElectronAuthorizationCode();
    capturePostHogEvent(postHog, 'auth/electron_session_transfer_started', {
      login_surface: loginSurface,
      launch_mode: detectAppLaunchMode(isElectronRenderer),
    });

    try {
      const result = await transferUser({
        fetchOptions: {
          query: electronOAuthQuery,
        },
      });
      const authorizationCode =
        result?.data?.electron_authorization_code ?? readElectronAuthorizationCode();
      clearElectronAuthorizationCode();
      if (!isCurrentAccount()) {
        logElectronOAuthDebug('login page discarded transferUser result after account switch');
        capturePostHogEvent(postHog, 'auth/electron_session_transfer_discarded', {
          login_surface: loginSurface,
          launch_mode: detectAppLaunchMode(isElectronRenderer),
          discard_reason: 'account_switched',
        });
        return;
      }
      if (!authorizationCode) {
        throw new Error('Missing Electron authorization code');
      }

      logElectronOAuthDebug('login page received electron authorization code from transferUser', {
        authorizationCodeLength: authorizationCode.length,
      });
      capturePostHogEvent(postHog, 'auth/electron_session_transfer_succeeded', {
        login_surface: loginSurface,
        launch_mode: detectAppLaunchMode(isElectronRenderer),
      });
      setElectronHandoffUrl(
        buildElectronRedirectUrl(
          authorizationCode,
          electronOAuthQuery.state,
          electronOAuthQuery.desktop_channel
        )
      );
    } catch (err) {
      if (!isCurrentAccount()) {
        logElectronOAuthDebug('login page ignored transferUser failure after account switch');
        return;
      }
      setError(t('login.loginFailed', 'Login failed. Please try again.'));
      capturePostHogEvent(postHog, 'auth/electron_session_transfer_failed', {
        login_surface: loginSurface,
        launch_mode: detectAppLaunchMode(isElectronRenderer),
        failure_reason: 'transfer_error',
        error_name: err instanceof Error ? err.name : typeof err,
        error_message: err instanceof Error ? err.message : String(err),
      });
      console.error('Electron transferUser error:', err);
      logElectronOAuthDebug('login page transferUser failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (isCurrentAccount()) {
        setIsPreparingElectronHandoff(false);
      }
    }
  }, [
    authClient,
    electronOAuthQuery,
    hasFailedElectronAccountSwitch,
    isElectronRenderer,
    loginSurface,
    postHog,
    t,
  ]);

  // Signing out here is the only way to hand the desktop app a different
  // account, and runs only on this explicit choice. The URL keeps this attempt's
  // `state`/`code_challenge`, so the desktop app's pending PKCE request still
  // matches after the next sign-in.
  const handleSwitchElectronAccount = useCallback(async () => {
    electronAccountGenerationRef.current += 1;
    autoOpenedElectronHandoffRef.current = null;
    setElectronHandoffUrl(null);
    setIsPreparingElectronHandoff(false);
    setError('');
    setHasFailedElectronAccountSwitch(false);
    clearElectronAuthorizationCode();
    setIsSwitchingElectronAccount(true);
    capturePostHogEvent(postHog, 'auth/electron_switch_account_started', {
      login_surface: loginSurface,
      launch_mode: detectAppLaunchMode(isElectronRenderer),
    });

    // Only a confirmed sign-out releases the handoff: on failure this browser is
    // still authenticated as the previous account, so say so and keep the
    // transfer blocked until a retry succeeds.
    const reportSwitchFailure = (reason: string, message?: string) => {
      setHasFailedElectronAccountSwitch(true);
      setError(
        t(
          'login.desktopHandoff.switchFailed',
          'Could not sign out of this browser. It is still signed in as the account above — try again.'
        )
      );
      capturePostHogEvent(postHog, 'auth/electron_switch_account_failed', {
        login_surface: loginSurface,
        launch_mode: detectAppLaunchMode(isElectronRenderer),
        failure_reason: reason,
        error_message: message,
      });
    };

    try {
      const outcome = await signOutWithoutRedirect(authClient);
      if (!outcome.ok) {
        reportSwitchFailure('sign_out_rejected', outcome.error.message);
      }
    } catch (err) {
      // `signOutWithoutRedirect` reports failures rather than throwing; this
      // covers a local-state clear that threw before the request was made.
      reportSwitchFailure('sign_out_threw', err instanceof Error ? err.message : String(err));
      console.error('Electron handoff account switch error:', err);
    } finally {
      setIsSwitchingElectronAccount(false);
    }
  }, [authClient, isElectronRenderer, loginSurface, postHog, t]);

  const handleLegalLinkClick = useCallback(
    async (event: React.MouseEvent<HTMLAnchorElement>, url: string) => {
      if (!isNativeApp) {
        return;
      }

      event.preventDefault();
      await openExternalUrl(url);
    },
    [isNativeApp]
  );

  // Attempt the app-scheme navigation from an effect rather than inline in the
  // transfer handler: the fallback link has to be painted before the attempt,
  // because a browser that refuses the custom scheme gives no callback and the
  // link is then the only way forward. Whether any given browser accepts this
  // automatic attempt is not something this page can determine.
  useEffect(() => {
    if (!electronHandoffUrl) {
      return;
    }
    if (autoOpenedElectronHandoffRef.current === electronHandoffUrl) {
      return;
    }
    autoOpenedElectronHandoffRef.current = electronHandoffUrl;
    redirectToElectronDeepLink(electronHandoffUrl);
  }, [electronHandoffUrl]);

  if (canRedirectAuthenticatedUser && !isElectronOAuthFlow) {
    return (
      <BrowserRedirect
        to={getRedirectTarget()}
        navigate={replaceLocation}
        beforeNavigate={prepareAuthenticatedRedirect}
      />
    );
  }

  // Token came back from the browser but the session hasn't resolved yet — show
  // a spinner so the desktop login reacts immediately to the deep link.
  if (isElectronRendererLogin && isCompletingElectronSignIn) {
    return (
      <LoadingPlaceholder
        variant="boot"
        title={t('login.completingSignIn', 'Signing you in...')}
        description={t('login.completingSignInDescription', 'Finishing sign-in from your browser.')}
      />
    );
  }

  const lastUsedBadge = <Badge>{t('login.lastUsed', 'Last used')}</Badge>;

  // One group of equal buttons: a provider is a choice, not a recommendation,
  // so none is filled. The method this device last completed carries a badge.
  const renderOAuthPanel = () => (
    <div {...stylex.props(styles.methods)}>
      <div {...stylex.props(styles.providerGroup)}>
        {PROVIDER_CONFIG.map((provider) => {
          const Icon = provider.icon;
          return (
            <Button
              key={provider.id}
              variant="secondary"
              size="large"
              onClick={() => {
                void handleSocialLogin(provider.id);
              }}
              disabled={isButtonsDisabled}
            >
              <span {...stylex.props(styles.methodContent)}>
                <Icon />
                <span {...stylex.props(styles.methodLabel)}>{getProviderLabel(provider.id)}</span>
                {lastLoginMethod === provider.id ? lastUsedBadge : null}
              </span>
            </Button>
          );
        })}
      </div>

      {canUseEmailPasswordLogin ? (
        <Button
          type="button"
          variant="ghost"
          size="large"
          onClick={handleEnterEmailView}
          disabled={isButtonsDisabled}
        >
          <span {...stylex.props(styles.methodContent)}>
            <ProviderIcon>
              <Mail strokeWidth={1.75} />
            </ProviderIcon>
            <span {...stylex.props(styles.methodLabel)}>{emailEntryLabel}</span>
            {lastLoginMethod === 'email' ? lastUsedBadge : null}
          </span>
        </Button>
      ) : null}
    </div>
  );

  const renderVerificationSentPanel = () => (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-3 pt-1 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Mail className="size-6 text-foreground" strokeWidth={1.75} aria-hidden="true" />
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          <Trans
            i18nKey="login.verificationSentBody"
            values={{ email: email.trim() }}
            components={{
              br: <br />,
              strong: <span className="font-medium text-foreground" />,
            }}
          />
        </p>
      </div>
      <div className="flex flex-col items-center gap-3 pt-1">
        <p className="text-xs text-muted-foreground">
          {t('login.newEmailAccountPrompt', 'Creating a new email account?')}{' '}
          <button
            type="button"
            onClick={() => void handleResendVerification()}
            disabled={isButtonsDisabled}
            className="font-medium text-foreground underline-offset-4 transition-colors hover:underline disabled:opacity-50"
          >
            {isResendingVerification
              ? t('login.resendingVerification', 'Sending...')
              : t('login.resendVerification', 'Resend')}
          </button>
        </p>
        <button
          type="button"
          onClick={handleForgotPassword}
          disabled={isButtonsDisabled}
          className="text-xs font-medium text-foreground underline-offset-4 transition-colors hover:underline disabled:opacity-50"
        >
          {t('login.setPasswordForExistingAccount', 'Set or reset password')}
        </button>
        <span className="h-px w-8 bg-border/70" aria-hidden="true" />
        <button
          type="button"
          onClick={handleExitEmailView}
          disabled={isButtonsDisabled}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          {t('login.backToSignIn', 'Back to sign-in options')}
        </button>
      </div>
    </div>
  );

  const renderEmailFormPanel = () => {
    const isSignUp = emailAuthMode === 'sign-up';
    const submitLabel = isEmailSubmitting
      ? isSignUp
        ? t('login.creatingAccount', 'Creating account...')
        : t('login.loading')
      : isSignUp
        ? t('login.createAccount', 'Create account')
        : t('login.emailSignIn', 'Sign in with email');

    return (
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void handleEmailSubmit(event);
        }}
        aria-labelledby="login-title"
        aria-describedby={effectiveError ? 'login-form-error' : undefined}
        aria-busy={isEmailSubmitting}
      >
        <div {...stylex.props(styles.fields)}>
          <LoginExpandingRow open={isSignUp} reducedMotion={!!prefersReducedMotion}>
            <div {...stylex.props(styles.nameField)}>
              <UiField.Label htmlFor="email-auth-name" className="text-xs font-medium">
                {t('login.nameLabel', 'Name')}
              </UiField.Label>
              <Input
                id="email-auth-name"
                autoComplete="name"
                value={emailName}
                required={isSignUp}
                disabled={isButtonsDisabled || !isSignUp}
                onChange={(event) => {
                  setEmailName(event.target.value);
                  setError('');
                }}
                placeholder={t('login.namePlaceholder', 'Jane Doe')}
                className="h-10"
              />
            </div>
          </LoginExpandingRow>

          <div {...stylex.props(styles.emailField)}>
            <UiField.Label htmlFor="email-auth-email" className="text-xs font-medium">
              {t('login.emailLabel', 'Email address')}
            </UiField.Label>
            <Input
              ref={emailInputRef}
              id="email-auth-email"
              type="email"
              autoComplete="email"
              value={email}
              required
              disabled={isButtonsDisabled}
              onChange={(event) => {
                setEmail(event.target.value);
                setError('');
                setEmailAuthStatus('idle');
              }}
              placeholder={t('login.emailPlaceholder', 'you@example.com')}
              className="h-10"
            />
          </div>

          <div {...stylex.props(styles.passwordField)}>
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <UiField.Label htmlFor="email-auth-password" className="text-xs font-medium">
                  {t('login.passwordLabel', 'Password')}
                </UiField.Label>
              </div>
              <PasswordInput
                id="email-auth-password"
                autoComplete={isSignUp ? 'new-password' : 'current-password'}
                value={password}
                required
                disabled={isButtonsDisabled}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError('');
                }}
                placeholder={
                  isSignUp
                    ? t('login.passwordSignUpPlaceholder', 'Letters and numbers, 8+ characters')
                    : t('login.passwordPlaceholder', 'At least 8 characters')
                }
                className="h-10"
                labels={{
                  show: t('login.showPassword', 'Show password'),
                  hide: t('login.hidePassword', 'Hide password'),
                }}
              />
            </div>
            <LoginExpandingRow open={!isSignUp} reducedMotion={!!prefersReducedMotion}>
              <div className="flex justify-end pt-1.5">
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  disabled={isButtonsDisabled || isSignUp}
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  {t('login.forgotPassword', 'Forgot password?')}
                </button>
              </div>
            </LoginExpandingRow>
          </div>

          <Button
            type="submit"
            aria-label={submitLabel}
            className="mt-1 h-10 w-full"
            disabled={isButtonsDisabled}
          >
            {isEmailSubmitting ? (
              <>
                <Spinner className="mr-2 h-4 w-4" />
                {submitLabel}
              </>
            ) : (
              <span aria-hidden="true" className="flex items-center justify-center gap-2">
                {submitLabel}
                <ArrowRight className="size-4 opacity-80" strokeWidth={1.75} />
              </span>
            )}
          </Button>

          {emailAuthStatus === 'unverified' && !isElectronRendererLogin ? (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => void handleResendVerification()}
                disabled={isButtonsDisabled}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                {isResendingVerification
                  ? t('login.resendingVerification', 'Sending...')
                  : t('login.resendVerification', 'Resend verification')}
              </button>
            </div>
          ) : null}
        </div>

        {!isElectronRendererLogin ? (
          <div className="text-center text-xs text-muted-foreground">
            {isSignUp ? (
              <>
                {t('login.haveAccountPrompt', 'Already have an account?')}{' '}
                <button
                  type="button"
                  onClick={handleToggleEmailAuthMode}
                  disabled={isButtonsDisabled}
                  className="font-medium text-foreground underline-offset-4 transition-colors hover:underline disabled:opacity-50"
                >
                  {t('login.emailSignInTab', 'Sign in')}
                </button>
              </>
            ) : (
              <>
                {t('login.noAccountPrompt', "Don't have an account?")}{' '}
                <button
                  type="button"
                  onClick={handleToggleEmailAuthMode}
                  disabled={isButtonsDisabled}
                  className="font-medium text-foreground underline-offset-4 transition-colors hover:underline disabled:opacity-50"
                >
                  {t('login.emailSignUpTab', 'Create account')}
                </button>
              </>
            )}
          </div>
        ) : null}
      </form>
    );
  };

  const renderEmailPanel = () =>
    emailAuthStatus === 'verification-sent'
      ? renderVerificationSentPanel()
      : renderEmailFormPanel();

  const renderElectronRendererPanel = () => (
    <div className="flex flex-col gap-3">
      <Button
        onClick={() => void handleElectronBrowserLogin()}
        className="h-10 w-full"
        disabled={isButtonsDisabled}
      >
        <SocialLoginButtonContent
          icon={<MajesticonsExternalLinkLine width={18} height={18} aria-hidden="true" />}
          label={
            isOpeningElectronBrowser
              ? t('login.openingBrowser', 'Opening browser...')
              : t('login.openBrowserSignIn', 'Open browser to sign in')
          }
          width={null}
        />
      </Button>
      <p className="text-center text-xs leading-5 text-muted-foreground">
        {electronLoginPhase === 'waiting'
          ? t('login.desktopWaiting')
          : t(
              'login.desktopBrowserHint',
              'Your browser will return you to Lody Desktop after sign-in.'
            )}
      </p>
      {isDevElectronEmailPasswordLoginEnabled ? (
        <Button
          type="button"
          variant="secondary"
          onClick={handleEnterEmailView}
          className="h-10 w-full"
          disabled={isButtonsDisabled}
        >
          <SocialLoginButtonContent
            icon={
              <ProviderIcon>
                <Mail strokeWidth={1.75} />
              </ProviderIcon>
            }
            label={emailEntryLabel}
            width={null}
          />
        </Button>
      ) : null}
    </div>
  );

  const renderElectronBrowserHandoffPanel = () => (
    <div className="flex flex-col gap-3">
      {electronHandoffAccountLabel ? (
        <div className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-center">
          <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground/80">
            {t('login.desktopHandoff.signedInAs', 'This browser is signed in as')}
          </div>
          <div
            className="truncate text-sm font-medium text-foreground"
            title={electronHandoffAccountLabel}
          >
            {electronHandoffAccountLabel}
          </div>
        </div>
      ) : null}

      {electronHandoffUrl ? (
        <Button
          render={<a href={electronHandoffUrl} data-electron-handoff-link />}
          className="h-10 w-full"
        >
          {/* A real link: the automatic navigation may be refused, and this is
              then the user's way to open the desktop app. */}
          <SocialLoginButtonContent
            icon={<MajesticonsExternalLinkLine width={18} height={18} aria-hidden="true" />}
            label={t('login.desktopHandoff.openApp', 'Open Lody Desktop')}
            width={null}
          />
        </Button>
      ) : (
        <Button
          type="button"
          onClick={() => void handleElectronSessionTransfer()}
          className="h-10 w-full"
          disabled={isButtonsDisabled || hasFailedElectronAccountSwitch}
        >
          {isPreparingElectronHandoff ? (
            <>
              <Spinner className="mr-2 h-4 w-4" />
              {t('login.desktopHandoff.preparing', 'Preparing desktop sign-in...')}
            </>
          ) : (
            <SocialLoginButtonContent
              icon={<ArrowRight />}
              label={t('login.desktopHandoff.continue', 'Continue with this account')}
              width={null}
            />
          )}
        </Button>
      )}

      {/* Deliberately not gated on `isButtonsDisabled`: a transfer in flight for
          the wrong account is exactly when the user needs this way out, and its
          late result is discarded by the account generation. */}
      <Button
        type="button"
        variant="secondary"
        onClick={() => void handleSwitchElectronAccount()}
        className="h-10 w-full"
        disabled={isSwitchingElectronAccount}
      >
        {isSwitchingElectronAccount
          ? t('login.desktopHandoff.switching', 'Signing out of this browser...')
          : t('login.desktopHandoff.switchAccount', 'Use a different account')}
      </Button>
    </div>
  );

  const isEmailVerificationSent = view === 'email' && emailAuthStatus === 'verification-sent';
  const headerTitle = (() => {
    if (isElectronBrowserHandoff) {
      return electronHandoffUrl
        ? t('login.redirectingToDesktop', 'Redirecting to desktop app')
        : t('login.desktopHandoff.title', 'Continue to Lody Desktop');
    }
    if (view !== 'email' || (isElectronRendererLogin && !isDevElectronEmailPasswordLoginEnabled)) {
      return t('login.title');
    }
    if (emailAuthStatus === 'verification-sent') {
      return t('login.verificationSentTitle', 'Check your inbox');
    }
    if (emailAuthMode === 'sign-up') {
      return t('login.createAccountTitle', 'Create your account');
    }
    return t('login.emailViewTitle', 'Sign in with email');
  })();
  const headerDescription = (() => {
    if (isElectronBrowserHandoff) {
      return electronHandoffUrl
        ? t(
            'login.desktopHandoff.openHint',
            'If the desktop app did not open, use the button below.'
          )
        : t(
            'login.desktopSessionTransfer',
            'Using your current web session to continue desktop sign-in.'
          );
    }
    if (isElectronRendererLogin && !isDevElectronEmailPasswordLoginEnabled) {
      return t(
        'login.desktopDescription',
        'Sign in from your browser to continue in Lody Desktop.'
      );
    }
    if (view !== 'email') {
      return t('login.description', 'Sign in to continue to your workspace.');
    }
    if (emailAuthMode === 'sign-up') {
      return t('login.createAccountDescription', 'Use your email and a password to get started.');
    }
    return t('login.emailViewDescription', 'Use your email address and password to continue.');
  })();

  const showElectronRendererPanel =
    isElectronRendererLogin && !(isDevElectronEmailPasswordLoginEnabled && view === 'email');
  const showBackButton = view === 'email' && canUseEmailPasswordLogin;
  // On a phone the visual sits above the form; the email form needs the room
  // (and the keyboard takes the rest), so the visual folds away there.
  const isVisualFolded = view === 'email';
  const entranceInitial = prefersReducedMotion ? false : 'hidden';

  return (
    <div {...stylex.props(styles.page)}>
      <WindowDragStrip />
      <section {...stylex.props(styles.visual, isVisualFolded && styles.visualFolded)}>
        <LoginDitherVisual keepClearRef={taglineRef} />
        {/* Temporarily hidden: bottom-left tagline, pending design feedback.
        <motion.p
          ref={taglineRef}
          initial={entranceInitial}
          animate="shown"
          variants={ENTRANCE_TAGLINE}
          {...stylex.props(styles.tagline)}
        >
          {t('login.tagline', 'A shared workspace for the coding agents your team already uses.')}
        </motion.p>
        */}
      </section>

      <motion.main
        initial={entranceInitial}
        animate="shown"
        variants={ENTRANCE_STAGGER}
        {...stylex.props(styles.panel)}
      >
        <motion.div variants={ENTRANCE_ITEM} {...stylex.props(styles.body)}>
          <div {...stylex.props(styles.scene)}>
            <div {...stylex.props(styles.header)}>
              <LoginExpandingRow open={showBackButton} reducedMotion={!!prefersReducedMotion}>
                <div {...stylex.props(styles.back)}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    onClick={handleExitEmailView}
                    disabled={isButtonsDisabled}
                  >
                    <ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />
                    {t('login.back', 'Back')}
                  </Button>
                </div>
              </LoginExpandingRow>
              <LoginExpandingRow
                open
                reducedMotion={!!prefersReducedMotion}
                contentKey={`${headerTitle}:${headerDescription}:${isEmailVerificationSent}`}
              >
                <h1 id="login-title" {...stylex.props(styles.title)}>
                  {headerTitle}
                </h1>
                {isEmailVerificationSent ? null : (
                  <p {...stylex.props(styles.description)}>{headerDescription}</p>
                )}
              </LoginExpandingRow>
            </div>

            {effectiveError ? (
              <p
                id="login-form-error"
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
              >
                {effectiveError}
                {effectiveErrorDetail ? (
                  <span className="mt-1 block select-text break-all text-[11px] opacity-80">
                    {effectiveErrorDetail}
                  </span>
                ) : null}
              </p>
            ) : null}

            {isElectronBrowserHandoff ? (
              renderElectronBrowserHandoffPanel()
            ) : (
              <LoginViewSlot
                active={view === 'email' && !showElectronRendererPanel ? 1 : 0}
                reducedMotion={!!prefersReducedMotion}
                onEntered={focusEmailInput}
                panels={[
                  isElectronRendererLogin ? renderElectronRendererPanel() : renderOAuthPanel(),
                  canUseEmailPasswordLogin ? renderEmailPanel() : null,
                ]}
              />
            )}

            {isEmailVerificationSent ? null : (
              <p {...stylex.props(styles.legal)}>
                <Trans
                  i18nKey="login.legalNotice"
                  components={{
                    br: <br />,
                    terms: (
                      <a
                        href={termsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(event) => void handleLegalLinkClick(event, termsUrl)}
                        {...stylex.props(styles.legalLink)}
                      />
                    ),
                    privacy: (
                      <a
                        href={privacyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(event) => void handleLegalLinkClick(event, privacyUrl)}
                        {...stylex.props(styles.legalLink)}
                      />
                    ),
                  }}
                />
              </p>
            )}
          </div>
        </motion.div>
      </motion.main>
    </div>
  );
}

const NARROW = '@media (max-width: 860px)';
// A phone on its side, or a very short window: no room for a visual above the form.
const NARROW_SHORT = '@media (max-width: 860px) and (max-height: 600px)';
const SAFE_TOP = 'max(12px, env(safe-area-inset-top))';
const SAFE_BOTTOM = 'max(12px, env(safe-area-inset-bottom))';

const styles = stylex.create({
  // The window holds two things: an inset visual surface and the sign-in
  // column. On a narrow window they stack, the visual on top.
  page: {
    boxSizing: 'border-box',
    display: 'grid',
    gridTemplateColumns: { default: 'minmax(0, 1fr) minmax(360px, 440px)', [NARROW]: '1fr' },
    gridTemplateRows: { default: '1fr', [NARROW]: 'auto minmax(0, 1fr)' },
    width: '100%',
    height: { default: '100vh', '@supports (height: 100dvh)': '100dvh' },
    paddingTop: SAFE_TOP,
    paddingBottom: SAFE_BOTTOM,
    paddingInline: '12px',
    backgroundColor: colors.background,
    color: colors.label,
  },
  visual: {
    position: 'relative',
    display: { default: 'block', [NARROW_SHORT]: 'none' },
    gridRow: { default: 'auto', [NARROW]: '1' },
    minWidth: 0,
    height: { default: 'auto', [NARROW]: 'clamp(200px, 42svh, 360px)' },
    overflow: 'hidden',
    borderRadius: radius.large,
    cornerShape: corner.shape,
    // Paper and ink of the dither: a step off the page, and the page's ink.
    // In dark mode the ink is mixed toward black so the jellyfish reads a
    // touch dimmer than interface white. (The dither resolves this colour by
    // painting it, which ignores alpha, so it must dim via colour, not opacity.)
    backgroundColor: `color-mix(in oklab, ${colors.label} 5%, ${colors.background})`,
    color: {
      default: colors.label,
      [DARK]: `color-mix(in oklab, ${colors.label} 88%, black)`,
    },
    transitionProperty: {
      default: 'none',
      [NARROW]: 'height, opacity',
      [REDUCED_MOTION]: 'none',
    },
    transitionDuration: '320ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  // Only a stacked layout folds; side by side there is room for both.
  visualFolded: {
    height: { default: null, [NARROW]: '0px' },
    opacity: { default: null, [NARROW]: 0 },
  },
  tagline: {
    position: 'absolute',
    insetInlineStart: { default: '40px', [NARROW]: '20px' },
    bottom: { default: '36px', [NARROW]: '20px' },
    maxWidth: { default: '460px', [NARROW]: 'calc(100% - 40px)' },
    margin: 0,
    fontFamily: 'var(--font-wordmark)',
    fontSize: { default: '30px', [NARROW]: '22px' },
    lineHeight: 1.15,
    letterSpacing: '-0.01em',
    color: colors.label,
  },
  // Keep the sign-in group at the bottom, within reach of a thumb when stacked.
  panel: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    // Its own row when stacked, so a hidden visual leaves it the full height.
    gridRow: { default: 'auto', [NARROW]: '2' },
    minHeight: 0,
    overflowY: 'auto',
    paddingTop: { default: '28px', [NARROW]: '24px' },
    paddingBottom: { default: '36px', [NARROW]: '12px' },
    paddingInlineStart: { default: '52px', [NARROW]: '20px' },
    paddingInlineEnd: { default: '40px', [NARROW]: '20px' },
  },
  body: {
    marginTop: 'auto',
    width: '100%',
    maxWidth: { default: '360px', [NARROW]: 'none' },
  },
  scene: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[6],
  },
  header: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'start',
  },
  fields: {
    display: 'flex',
    flexDirection: 'column',
  },
  nameField: {
    display: 'grid',
    gap: space[1.5],
    paddingBottom: space[3],
  },
  emailField: {
    display: 'grid',
    gap: space[1.5],
    marginBottom: space[3],
  },
  passwordField: {
    display: 'grid',
    marginBottom: space[3],
  },
  back: {
    marginInlineStart: '-10px',
    paddingBottom: space[2],
  },
  title: {
    margin: 0,
    fontSize: '28px',
    lineHeight: 1.2,
    fontWeight: 600,
    letterSpacing: '-0.025em',
    color: colors.label,
  },
  description: {
    margin: 0,
    marginTop: space[2],
    fontSize: '14px',
    lineHeight: 1.5,
    color: colors.secondaryLabel,
  },
  methods: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  providerGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  // Icon and label start at the button's edge so every row lines up, and the
  // badge takes the far end.
  methodContent: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    minWidth: 0,
  },
  methodLabel: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    textAlign: 'start',
  },
  legal: {
    margin: 0,
    paddingTop: '16px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
    fontSize: '11px',
    lineHeight: 1.6,
    color: colors.tertiaryLabel,
  },
  legalLink: {
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    textDecoration: 'underline',
    textUnderlineOffset: '3px',
  },
});
