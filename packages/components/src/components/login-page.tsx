import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, ExternalLink, Github, Loader2, Mail } from 'lucide-react';
import { usePostHog } from '@posthog/react';
import { useAtomValue, useSetAtom } from 'jotai';
import isEmail from 'validator/lib/isEmail';
import { electronDeepLinkSignInInProgressAtom, nativeSignInInProgressAtom } from '@/atoms';
import { Button } from '@lody/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { PasswordInput } from '@/ui/password-input';
import { isDevEmailPasswordLoginEnabled } from '@lody/shared/electron-ipc';
import { setLoginHintCookie } from '@/lib/login-hint-cookie';
import { formatPasswordValidationFailure, validateNewPassword } from '@/lib/password-validation';
import { LoadingPlaceholder } from '@/components/loading-placeholder';
import { useStableSession } from '@/hooks/useStableSession';
import { hasUsableSessionUser } from '@/hooks/stable-session-state';
import {
  buildElectronWebLoginCallbackUrl,
  clearElectronAuthorizationCode,
  type ElectronOAuthQuery,
  readElectronAuthorizationCode,
  redirectToElectronWithAuthorizationCode,
} from '@/lib/electron-oauth';
import { useAuthClient } from '../providers/convex-provider';
import {
  getAppCurrentPathWithSearch,
  getAppOriginForUrlParsing,
  getAppWindowSearchParams,
  replaceAppWindowLocation,
} from '@/lib/app-location';
import { isSafeAuthRedirect } from '@/lib/auth-redirect';
import { openExternalUrl } from '@/lib/native-browser';
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
import lodyLogo from '@/assets/lody-icon.png';

const LEGAL_LINK_FALLBACK_ORIGIN = 'https://lody.ai';
const ELECTRON_OAUTH_DEBUG_PREFIX = '[electron-oauth-debug]';

type SocialProvider = 'github' | 'google' | 'apple' | 'discord';
type EmailAuthMode = 'sign-in' | 'sign-up';
type EmailAuthStatus = 'idle' | 'verification-sent' | 'unverified';
type LoginView = 'oauth' | 'email';

const PROVIDER_ICON_SIZE = 18;
const PROVIDER_ICON_GAP = 8;

const VIEW_TRANSITION = { duration: 0.22, ease: [0.4, 0, 0.2, 1] as const };

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
  if (clientId !== 'electron' || !state || !codeChallenge) {
    return undefined;
  }

  const query: ElectronOAuthQuery = {
    client_id: clientId,
    state,
    code_challenge: codeChallenge,
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

  return null;
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
  variant: 'primary' | 'secondary';
}[] = [
  {
    id: 'github',
    icon: GitHubIcon,
    labelKey: 'login.githubSignIn',
    labelDefault: 'Continue with GitHub',
    variant: 'primary',
  },
  {
    id: 'google',
    icon: GoogleIcon,
    labelKey: 'login.googleSignIn',
    labelDefault: 'Continue with Google',
    variant: 'secondary',
  },
  {
    id: 'apple',
    icon: AppleIcon,
    labelKey: 'login.appleSignIn',
    labelDefault: 'Continue with Apple',
    variant: 'secondary',
  },
  {
    id: 'discord',
    icon: DiscordIcon,
    labelKey: 'login.discordSignIn',
    labelDefault: 'Continue with Discord',
    variant: 'secondary',
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
  // Set the instant the browser hands the auth token back via the `lody://auth/
  // callback#token=…` deep link (detected centrally in DesktopDeepLinkRouter), so
  // the desktop login shows a "signing in" spinner while better-auth exchanges
  // the token for a session.
  const isCompletingElectronSignIn = useAtomValue(electronDeepLinkSignInInProgressAtom);
  const setNativeSignInInProgress = useSetAtom(nativeSignInInProgressAtom);
  const [providerContentWidth, setProviderContentWidth] = useState<number | null>(null);
  const hasAutoElectronBridgeAttemptedRef = useRef(false);
  const providerLabelMeasureRef = useRef<HTMLDivElement | null>(null);
  const emailInputRef = useRef<HTMLInputElement | null>(null);
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
  const effectiveError = error || expiredMessage;
  const isAnyLoading =
    loadingProvider !== null ||
    isEmailSubmitting ||
    isResendingVerification ||
    isOpeningElectronBrowser;
  const isButtonsDisabled = isAnyLoading || (hasLocalToken && (isPending || isRetrying));
  const providerCount = isElectronRendererLogin ? 1 : PROVIDER_CONFIG.length;
  const getProviderLabel = (provider: SocialProvider) => {
    const config = PROVIDER_CONFIG.find((c) => c.id === provider);
    if (!config) return '';
    return loadingProvider === provider
      ? t('login.loading')
      : t(config.labelKey, config.labelDefault);
  };

  const githubLabel = getProviderLabel('github');
  const googleLabel = getProviderLabel('google');
  const appleLabel = getProviderLabel('apple');
  const discordLabel = getProviderLabel('discord');
  const emailEntryLabel = t('login.continueWithEmail', 'Continue with email');

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

  useLayoutEffect(() => {
    const labelContainer = providerLabelMeasureRef.current;
    if (!labelContainer) {
      return;
    }

    const labelElements = Array.from(
      labelContainer.querySelectorAll<HTMLElement>('[data-provider-label]')
    );
    if (labelElements.length === 0) {
      return;
    }

    const maxLabelWidth = Math.max(
      ...labelElements.map((element) => Math.ceil(element.getBoundingClientRect().width))
    );
    const nextWidth = maxLabelWidth + PROVIDER_ICON_SIZE + PROVIDER_ICON_GAP;
    setProviderContentWidth((currentWidth) =>
      currentWidth === nextWidth ? currentWidth : nextWidth
    );
  }, [githubLabel, googleLabel, appleLabel, discordLabel, emailEntryLabel]);

  useEffect(() => {
    if (view !== 'email') {
      return undefined;
    }
    // Defer focus until the slide-in transition has settled so the browser does
    // not interrupt the framer-motion animation by scrolling the input into view.
    const handle = window.setTimeout(() => {
      emailInputRef.current?.focus();
    }, 220);
    return () => window.clearTimeout(handle);
  }, [view]);

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

    setError('');
    setLoadingProvider('github');
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
      if (!authorizationCode) {
        throw new Error('Missing Electron authorization code');
      }

      logElectronOAuthDebug('login page received electron authorization code from transferUser', {
        authorizationCodeLength: authorizationCode.length,
      });
      clearElectronAuthorizationCode();
      capturePostHogEvent(postHog, 'auth/electron_session_transfer_succeeded', {
        login_surface: loginSurface,
        launch_mode: detectAppLaunchMode(isElectronRenderer),
      });
      redirectToElectronWithAuthorizationCode(authorizationCode, electronOAuthQuery.state);
    } catch (err) {
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
      setLoadingProvider(null);
    }
  }, [authClient, electronOAuthQuery, isElectronRenderer, loginSurface, postHog, t]);

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

  useEffect(() => {
    if (!isElectronOAuthFlow || !canRedirectAuthenticatedUser) {
      return;
    }
    if (hasAutoElectronBridgeAttemptedRef.current) {
      return;
    }
    hasAutoElectronBridgeAttemptedRef.current = true;
    void handleElectronSessionTransfer();
  }, [canRedirectAuthenticatedUser, handleElectronSessionTransfer, isElectronOAuthFlow]);

  if (isElectronOAuthFlow && canRedirectAuthenticatedUser && !error) {
    return (
      <LoadingPlaceholder
        title={t('login.redirectingToDesktop', 'Redirecting to desktop app')}
        description={t(
          'login.desktopSessionTransfer',
          'Using your current web session to continue desktop sign-in.'
        )}
      />
    );
  }

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
        title={t('login.completingSignIn', 'Signing you in...')}
        description={t('login.completingSignInDescription', 'Finishing sign-in from your browser.')}
      />
    );
  }

  const renderOAuthPanel = () => (
    <motion.div
      key="oauth"
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -12 }}
      transition={VIEW_TRANSITION}
      className="flex flex-col gap-2.5"
    >
      {PROVIDER_CONFIG.map((provider) => {
        const Icon = provider.icon;
        return (
          <Button
            key={provider.id}
            size="large"
            onClick={() => {
              void handleSocialLogin(provider.id);
            }}
            className="w-full"
            disabled={isButtonsDisabled}
            variant={provider.variant}
          >
            <SocialLoginButtonContent
              icon={<Icon />}
              label={getProviderLabel(provider.id)}
              width={providerContentWidth}
            />
          </Button>
        );
      })}

      {canUseEmailPasswordLogin ? (
        <>
          <div className="my-1 flex items-center gap-3 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/70">
            <span className="h-px flex-1 bg-border/70" />
            <span>{t('login.orContinueWith', 'or')}</span>
            <span className="h-px flex-1 bg-border/70" />
          </div>

          <Button
            type="button"
            variant="secondary"
            size="large"
            onClick={handleEnterEmailView}
            className="w-full"
            disabled={isButtonsDisabled}
          >
            <SocialLoginButtonContent
              icon={
                <ProviderIcon>
                  <Mail strokeWidth={1.75} className="size-4" />
                </ProviderIcon>
              }
              label={emailEntryLabel}
              width={providerContentWidth}
            />
          </Button>
        </>
      ) : null}
    </motion.div>
  );

  const renderVerificationSentPanel = () => (
    <motion.div
      key="verification-sent"
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -12 }}
      transition={VIEW_TRANSITION}
      className="flex flex-col gap-5"
    >
      <div className="flex flex-col items-center gap-3 pt-1 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <Mail className="size-6 text-primary" strokeWidth={1.75} aria-hidden="true" />
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
    </motion.div>
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
      <motion.form
        key="email-form"
        initial={{ opacity: 0, x: 12 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -12 }}
        transition={VIEW_TRANSITION}
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void handleEmailSubmit(event);
        }}
        aria-labelledby="login-title"
        aria-describedby={effectiveError ? 'login-form-error' : undefined}
        aria-busy={isEmailSubmitting}
      >
        <div className="flex flex-col gap-3">
          <AnimatePresence initial={false}>
            {isSignUp ? (
              <motion.div
                key="name-field"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={VIEW_TRANSITION}
                className="overflow-hidden"
              >
                <div className="grid gap-1.5 pb-3">
                  <Label htmlFor="email-auth-name" className="text-xs font-medium">
                    {t('login.nameLabel', 'Name')}
                  </Label>
                  <Input
                    id="email-auth-name"
                    autoComplete="name"
                    value={emailName}
                    required
                    disabled={isButtonsDisabled}
                    onChange={(event) => {
                      setEmailName(event.target.value);
                      setError('');
                    }}
                    placeholder={t('login.namePlaceholder', 'Jane Doe')}
                    className="h-10"
                  />
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>

          <div className="grid gap-1.5">
            <Label htmlFor="email-auth-email" className="text-xs font-medium">
              {t('login.emailLabel', 'Email address')}
            </Label>
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

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="email-auth-password" className="text-xs font-medium">
                {t('login.passwordLabel', 'Password')}
              </Label>
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
              showPasswordLabel={t('login.showPassword', 'Show password')}
              hidePasswordLabel={t('login.hidePassword', 'Hide password')}
            />
            {!isSignUp ? (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  disabled={isButtonsDisabled}
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  {t('login.forgotPassword', 'Forgot password?')}
                </button>
              </div>
            ) : null}
          </div>

          <Button type="submit" size="large" className="mt-1 w-full" disabled={isButtonsDisabled}>
            {isEmailSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {submitLabel}
              </>
            ) : (
              <span className="flex items-center justify-center gap-2">
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
      </motion.form>
    );
  };

  const renderEmailPanel = () => (
    <motion.div
      key="email"
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 12 }}
      transition={VIEW_TRANSITION}
    >
      <AnimatePresence mode="wait" initial={false}>
        {emailAuthStatus === 'verification-sent'
          ? renderVerificationSentPanel()
          : renderEmailFormPanel()}
      </AnimatePresence>
    </motion.div>
  );

  const renderElectronRendererPanel = () => (
    <motion.div
      key="electron"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={VIEW_TRANSITION}
      className="flex flex-col gap-3"
    >
      <Button
        size="large"
        onClick={() => void handleElectronBrowserLogin()}
        className="w-full"
        disabled={isButtonsDisabled}
      >
        <SocialLoginButtonContent
          icon={<ExternalLink />}
          label={
            isOpeningElectronBrowser
              ? t('login.openingBrowser', 'Opening browser...')
              : t('login.openBrowserSignIn', 'Open browser to sign in')
          }
          width={null}
        />
      </Button>
      <p className="text-center text-xs leading-5 text-muted-foreground">
        {t(
          'login.desktopBrowserHint',
          'Your browser will return you to Lody Desktop after sign-in.'
        )}
      </p>
      {isDevElectronEmailPasswordLoginEnabled ? (
        <Button
          type="button"
          variant="secondary"
          size="large"
          onClick={handleEnterEmailView}
          className="w-full"
          disabled={isButtonsDisabled}
        >
          <SocialLoginButtonContent
            icon={
              <ProviderIcon>
                <Mail strokeWidth={1.75} className="size-4" />
              </ProviderIcon>
            }
            label={emailEntryLabel}
            width={null}
          />
        </Button>
      ) : null}
    </motion.div>
  );

  const isEmailVerificationSent = view === 'email' && emailAuthStatus === 'verification-sent';
  const headerTitle = (() => {
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

  return (
    <div className="relative flex h-screen w-full items-center justify-center bg-background p-4">
      <WindowDragStrip />
      <motion.div
        layout
        transition={VIEW_TRANSITION}
        className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-border/60 bg-card shadow-[0_8px_30px_-12px_rgba(0,0,0,0.12)]"
      >
        <AnimatePresence initial={false}>
          {view === 'email' &&
          (!isElectronRendererLogin || isDevElectronEmailPasswordLoginEnabled) ? (
            <motion.button
              key="back"
              type="button"
              aria-label={t('login.back', 'Back')}
              onClick={handleExitEmailView}
              disabled={isButtonsDisabled}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={VIEW_TRANSITION}
              className={cn(
                'absolute left-3 top-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors',
                'hover:bg-hover hover:text-foreground',
                'focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring',
                'disabled:opacity-50'
              )}
            >
              <ArrowLeft className="size-4" strokeWidth={1.75} />
            </motion.button>
          ) : null}
        </AnimatePresence>

        <div className="px-7 pb-6 pt-7">
          <div className="flex flex-col items-center gap-3 pb-6 text-center">
            <img src={lodyLogo} alt="Lody" className="h-12 w-12 object-contain" draggable={false} />
            <div className="space-y-1">
              <h1
                id="login-title"
                className="text-xl font-semibold leading-tight tracking-tight text-foreground"
              >
                {headerTitle}
              </h1>
              {isEmailVerificationSent ? null : (
                <p className="text-sm text-muted-foreground">{headerDescription}</p>
              )}
            </div>
          </div>

          {!isElectronRendererLogin ? (
            <div
              ref={providerLabelMeasureRef}
              aria-hidden="true"
              className="pointer-events-none absolute left-0 top-0 -z-10 opacity-0"
            >
              <div className="flex flex-col gap-2 text-sm font-medium">
                {PROVIDER_CONFIG.map((provider) => (
                  <span key={provider.id} data-provider-label>
                    {getProviderLabel(provider.id)}
                  </span>
                ))}
                <span data-provider-label>{emailEntryLabel}</span>
              </div>
            </div>
          ) : null}

          <AnimatePresence initial={false} mode="wait">
            {effectiveError ? (
              <motion.p
                key={effectiveError}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={VIEW_TRANSITION}
                id="login-form-error"
                role="alert"
                className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-center text-xs text-destructive"
              >
                {effectiveError}
              </motion.p>
            ) : null}
          </AnimatePresence>

          <AnimatePresence mode="wait" initial={false}>
            {isElectronRendererLogin &&
            !(isDevElectronEmailPasswordLoginEnabled && view === 'email')
              ? renderElectronRendererPanel()
              : view === 'oauth'
                ? renderOAuthPanel()
                : renderEmailPanel()}
          </AnimatePresence>

          {view === 'email' && emailAuthStatus === 'verification-sent' ? null : (
            <p className="mt-6 text-center text-[11px] leading-5 text-muted-foreground/80">
              <Trans
                i18nKey="login.legalNotice"
                components={{
                  br: <br />,
                  terms: (
                    <a
                      href={termsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-4 hover:text-foreground"
                      onClick={(event) => void handleLegalLinkClick(event, termsUrl)}
                    />
                  ),
                  privacy: (
                    <a
                      href={privacyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-4 hover:text-foreground"
                      onClick={(event) => void handleLegalLinkClick(event, privacyUrl)}
                    />
                  ),
                }}
              />
            </p>
          )}
        </div>
      </motion.div>
    </div>
  );
}
