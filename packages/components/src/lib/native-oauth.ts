const DEFAULT_NATIVE_OAUTH_RETURN_GRACE_MS = 800;
const SESSION_UPDATE_EVENT = 'better-auth:session-update';

export type NativeOAuthSignInOutcome = 'completed' | 'returned_without_session';

type NativeOAuthEventTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

type NativeOAuthDocument = NativeOAuthEventTarget & {
  visibilityState?: DocumentVisibilityState;
};

type NativeOAuthWindow = NativeOAuthEventTarget & {
  document?: NativeOAuthDocument;
};

type RunNativeOAuthSignInOptions = {
  appWindow?: NativeOAuthWindow;
  returnGraceMs?: number;
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isVisible = (appDocument: NativeOAuthDocument | undefined) =>
  !appDocument || appDocument.visibilityState !== 'hidden';

export function waitForNativeOAuthReturn(appWindow: NativeOAuthWindow): Promise<void> {
  const appDocument = appWindow.document;
  let hasLeftApp = appDocument?.visibilityState === 'hidden';

  return new Promise((resolve) => {
    let resolved = false;
    const cleanups: Array<() => void> = [];

    const cleanup = () => {
      for (const remove of cleanups.splice(0)) {
        remove();
      }
    };

    const resolveOnce = () => {
      if (resolved) {
        return;
      }
      resolved = true;
      cleanup();
      resolve();
    };

    const markLeftApp = () => {
      hasLeftApp = true;
    };

    const resolveIfReturned = () => {
      if (hasLeftApp && isVisible(appDocument)) {
        resolveOnce();
      }
    };

    const onVisibilityChange = () => {
      if (!isVisible(appDocument)) {
        markLeftApp();
        return;
      }
      resolveIfReturned();
    };

    const addListener = (
      target: NativeOAuthEventTarget | undefined,
      event: string,
      fn: () => void
    ) => {
      if (!target) {
        return;
      }
      target.addEventListener(event, fn);
      cleanups.push(() => target.removeEventListener(event, fn));
    };

    addListener(appWindow, 'blur', markLeftApp);
    addListener(appWindow, 'pagehide', markLeftApp);
    addListener(appWindow, 'focus', resolveIfReturned);
    addListener(appWindow, 'pageshow', resolveIfReturned);
    addListener(appDocument, 'visibilitychange', onVisibilityChange);
  });
}

export async function runNativeOAuthSignIn(
  startSignIn: () => Promise<unknown>,
  options: RunNativeOAuthSignInOptions = {}
): Promise<NativeOAuthSignInOutcome> {
  const appWindow =
    options.appWindow ??
    (typeof window === 'undefined' ? undefined : (window as NativeOAuthWindow));

  if (!appWindow) {
    await startSignIn();
    return 'completed';
  }

  let sessionUpdated = false;
  const markSessionUpdated = () => {
    sessionUpdated = true;
  };
  appWindow.addEventListener(SESSION_UPDATE_EVENT, markSessionUpdated);

  // Android Custom Tabs can return to the app without resolving the native auth call.
  // Race app-return against sign-in so a closed browser tab does not keep the login UI locked.
  const returnedWithoutSession = waitForNativeOAuthReturn(appWindow)
    .then(() => delay(options.returnGraceMs ?? DEFAULT_NATIVE_OAUTH_RETURN_GRACE_MS))
    .then((): NativeOAuthSignInOutcome =>
      sessionUpdated ? 'completed' : 'returned_without_session'
    );

  const signInCompleted = startSignIn().then((): NativeOAuthSignInOutcome => 'completed');

  try {
    return await Promise.race([signInCompleted, returnedWithoutSession]);
  } finally {
    appWindow.removeEventListener(SESSION_UPDATE_EVENT, markSessionUpdated);
  }
}
