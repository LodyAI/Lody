import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const mobile = createRequire(new URL('../package.json', import.meta.url));
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const componentsPath = path.join(repo, 'packages/components/src');
const sharedPath = path.join(repo, 'packages/shared/src');
const components = createRequire(path.join(componentsPath, '../package.json'));
const shared = createRequire(path.join(sharedPath, '../package.json'));
const ts = mobile('typescript');
const React = mobile('react');
const Jotai = mobile('jotai');
const { JSDOM } = components('jsdom');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Exercise the production adapters, auth intent and runtime/route atoms together.
// Only native storage, query results and time are controlled; each fixture is a
// new page/module lifetime, while `cache` can survive that page's disposal.
export async function createWidgetFixture({
  cache = new Map(),
  userId = 'user-a',
  workspaceId = 'workspace-a',
  workspaceSlug = 'example',
  title = 'Synthetic private task',
  authSessionId = 'auth-a',
} = {}) {
  const dom = new JSDOM('<div id="root"></div>');
  const previousGlobals = new Map(
    ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ])
  );
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = mobile('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root'));
  const store = Jotai.createStore();
  const userAtom = Jotai.atom({ id: userId });
  const sessionsAtom = Jotai.atom([]);
  const metadataAtom = Jotai.atom(null);
  const configsAtom = Jotai.atom([]);
  const machinesAtom = Jotai.atom(new Map());
  const onlineAtom = Jotai.atom(new Set());
  const localeAtom = Jotai.atom('en');
  let quotaRefresh = async () => false;
  const credentials = new Map([['lody_auth_token', 'synthetic-token-a']]);
  const listeners = new Set();
  const timers = new Map();
  let now = Date.UTC(2026, 9, 14, 3);
  let timerId = 0;
  const schedule = (callback, delay = 0) => {
    const id = ++timerId;
    timers.set(id, { callback, at: now + delay });
    return id;
  };
  function advanceTimers(ms) {
    const end = now + ms;
    for (;;) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      now = timer.at;
      timer.callback();
    }
    now = end;
  }
  class Clock extends Date {
    static now() {
      return now;
    }
  }

  const blockedWrites = new Map();
  const failedWrites = new Map();
  const releases = new Set();
  const syncOwners = new Set();
  async function persist(kind, value, pendingScope) {
    if (pendingScope && value === null) {
      const previous = cache.get(kind);
      if (
        previous?.userId === pendingScope.userId &&
        previous.workspaceId === pendingScope.workspaceId
      )
        return;
    }
    const block = blockedWrites.get(kind);
    if (block && value !== null) {
      blockedWrites.delete(kind);
      block.started.resolve();
      await block.finished.promise;
    }
    const failure = failedWrites.get(kind);
    failedWrites.delete(kind);
    if (!failure || failure.afterWrite) cache.set(kind, structuredClone(value));
    if (failure) {
      failure.started.resolve();
      throw new Error('Synthetic native cache failure');
    }
  }
  const bridge = {
    syncSummary: ({ summary, pendingScope }) => persist('conversation', summary, pendingScope),
    syncTokenUsage: ({ summary }) => persist('token', summary),
    syncProviderQuota: ({ summary, pendingScope }) => persist('quota', summary, pendingScope),
  };
  const signOutFinished = deferred();
  const authClient = { signOut: () => signOutFinished.promise };
  let signingOut;
  let auth = {
    authSessionId,
    isAuthenticated: true,
    confirmedUnauthenticated: false,
    isRecovering: false,
    requestAuthRecovery() {},
    claimAutomaticCommand: () => true,
  };
  const queryResults = new Map();
  const queryListeners = new Set();
  const queryKey = (sessionId, id) => JSON.stringify([sessionId, id]);
  let AuthContext;
  function useCloudQuery(_operation, args) {
    const { authSessionId: currentAuthSessionId } = React.useContext(AuthContext);
    const key = args === 'skip' ? null : queryKey(currentAuthSessionId, args.workspaceId);
    return React.useSyncExternalStore(
      (notify) => {
        queryListeners.add(notify);
        return () => queryListeners.delete(notify);
      },
      () => (key === null ? undefined : queryResults.get(key))
    );
  }
  const context = vm.createContext({
    console,
    TextEncoder,
    Date: Clock,
    Error,
    TypeError,
    Promise,
    queueMicrotask,
    window: { setTimeout: schedule, clearTimeout: (id) => timers.delete(id) },
  });
  const synthetic = (exports) =>
    new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      },
      { context }
    );
  const stubs = new Map([
    ['react', synthetic(React)],
    ['react/jsx-runtime', synthetic(mobile('react/jsx-runtime'))],
    ['jotai', synthetic(Jotai)],
    ['loro-mirror', synthetic(shared('loro-mirror'))],
    ['effect', synthetic(components('effect'))],
    ['zod', synthetic(shared('zod'))],
    ['convex/values', synthetic(components('convex/values'))],
    ['@lody/components/lib', synthetic({ jotaiStore: store })],
    ['@lody/components/atoms/index', synthetic({ userAtom })],
    [
      '@lody/components/atoms/doc-meta',
      synthetic({ allActiveSessionsAtom: sessionsAtom, docMetaCacheScopeAtom: metadataAtom }),
    ],
    ['@lody/components/atoms/agents', synthetic({ getAllAgentConfigAtom: configsAtom })],
    ['@lody/components/atoms/machines', synthetic({ getMachineMetaMapAtom: machinesAtom })],
    ['@lody/components/atoms/settings', synthetic({ languageAtom: localeAtom })],
    [
      '@lody/components/atoms/presence',
      synthetic({
        lodyPresenceNowMsAtom: Jotai.atom(now),
        lodyPresenceStatesAtom: Jotai.atom({}),
        onlineMachineIdsAtom: onlineAtom,
      }),
    ],
    [
      '@capacitor/core',
      synthetic({ Capacitor: { getPlatform: () => 'ios' }, registerPlugin: () => bridge }),
    ],
    [
      '@capacitor/app',
      synthetic({
        App: {
          async addListener(_event, listener) {
            listeners.add(listener);
            return {
              async remove() {
                listeners.delete(listener);
              },
            };
          },
        },
      }),
    ],
    ['better-auth/react', synthetic({ createAuthClient: () => ({}) })],
    ['better-auth/client/plugins', synthetic({ organizationClient: () => ({}) })],
    [
      '@convex-dev/better-auth/client/plugins',
      synthetic({ convexClient: () => ({}), crossDomainClient: () => ({}) }),
    ],
    ['@lody/platform/react', synthetic({ useCloudQuery, usePlatformCapability: () => true })],
    [
      '@lody/components/hooks/use-legacy-workspace-query',
      synthetic({ useLegacyWorkspaceQuery: useCloudQuery }),
    ],
    [
      '@lody/components/lib/cloud-api-operations',
      synthetic({ cloudOperations: { usage: { getWorkspaceUsageTimeline: {} } } }),
    ],
    ['@lody/components/lib/format-compact-number', synthetic({ formatCompactNumber: String })],
    ['@lody/components/lib/intl-locale', synthetic({ toIntlLocaleOrEn: (locale) => locale })],
    ['@/components/shared/acp-selector-options', synthetic({ stripRecommended: (value) => value })],
    ['react-i18next', synthetic({ useTranslation: () => ({ i18n: { resolvedLanguage: 'en' } }) })],
    ['@/lib/utils', synthetic({ jotaiStore: store })],
    ['@/lib/posthog-analytics', synthetic({ capturePostHogEvent() {} })],
    ['@/components/error-boundary-fallback', synthetic({ ErrorBoundaryFallback: () => null })],
  ]);
  const deferredPostHog = synthetic({ deferredPostHog: { reset() {}, captureException() {} } });
  stubs.set('@/lib/deferred-posthog', deferredPostHog);
  const files = new Map([
    [
      path.join(componentsPath, 'lib/auth-bootstrap.ts'),
      synthetic({
        readStoredAuthToken: () => credentials.get('lody_auth_token') ?? null,
        clearStoredAuthToken: () => credentials.delete('lody_auth_token'),
        writeStoredAuthToken: (token) => credentials.set('lody_auth_token', token),
        clearAuthBootstrapSnapshot() {},
      }),
    ],
    [path.join(componentsPath, 'lib/deferred-posthog.ts'), deferredPostHog],
    [
      path.join(componentsPath, 'lib/auth-client-singleton.ts'),
      synthetic({ registerAuthClient() {} }),
    ],
    [
      path.join(componentsPath, 'lib/app-location.ts'),
      synthetic({ replaceAppWindowLocation() {} }),
    ],
    [path.join(componentsPath, 'lib/login-hint-cookie.ts'), synthetic({ setLoginHintCookie() {} })],
    [
      path.join(componentsPath, 'lib/workspace.ts'),
      synthetic({ clearPreferredWorkspaceSlug() {} }),
    ],
    [
      path.join(sharedPath, 'session-status-machine.ts'),
      synthetic({ isSessionActiveWithHeartbeat: () => false }),
    ],
    [
      path.join(sharedPath, 'agent-brand.ts'),
      synthetic({
        resolveAgentBrandId: () => null,
        isAgentBrandId: unexpectedAuthenticationCall,
      }),
    ],
    [
      path.join(sharedPath, 'ai.ts'),
      synthetic({ isManagedBuiltinAgentType: unexpectedAuthenticationCall }),
    ],
    [
      path.join(sharedPath, 'machine-flock.ts'),
      synthetic({ getSessionLaunchConfigLegacyFields: () => ({}) }),
    ],
  ]);
  // Quota eligibility uses the real authentication env keys, but does not run
  // interactive sign-in policy or require the ACP adapter runtime in this VM.
  function unexpectedAuthenticationCall() {
    throw new Error('Widget fixture unexpectedly invoked interactive authentication policy');
  }
  const modules = new Map();
  function load(file) {
    if (files.has(file)) return files.get(file);
    if (modules.has(file)) return modules.get(file);
    const source = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText;
    const module = new vm.SourceTextModule(source, {
      context,
      identifier: file,
      initializeImportMeta(meta) {
        meta.env = {};
      },
    });
    modules.set(file, module);
    return module;
  }
  function linker(specifier, parent) {
    if (stubs.has(specifier)) return stubs.get(specifier);
    let file;
    if (specifier.startsWith('@lody/components/')) {
      file = path.join(componentsPath, specifier.slice('@lody/components/'.length) + '.ts');
    } else if (specifier === '@lody/platform/telemetry') {
      file = path.join(repo, 'packages/platform/src/telemetry.ts');
    } else if (specifier === '@lody/shared/bug-report-client-log') {
      file = path.join(sharedPath, 'bug-report-client-log.ts');
    } else if (specifier.startsWith('@/')) {
      file = path.join(componentsPath, specifier.slice(2) + '.ts');
      if (specifier === '@/components/error-boundary') file += 'x';
    } else if (specifier.startsWith('.')) {
      file = path.resolve(path.dirname(parent.identifier), specifier + '.ts');
    } else {
      throw new Error(`Unexpected widget fixture import: ${specifier}`);
    }
    return load(file);
  }
  async function evaluate(file) {
    const module = load(file);
    if (module.status === 'unlinked') await module.link(linker);
    if (module.status === 'linked') await module.evaluate();
    return module.namespace;
  }
  const live = await evaluate(path.join(sharedPath, 'live-activity-summary.ts'));
  const sharedAuth = await evaluate(path.join(sharedPath, 'auth.ts'));
  const rateLimits = await evaluate(path.join(sharedPath, 'acp/lody-rate-limit-migration.ts'));
  const subscriptionQuota = await evaluate(path.join(sharedPath, 'subscription-quota.ts'));
  const schema = await evaluate(path.join(sharedPath, 'schema.ts'));
  stubs.set(
    '@lody/shared',
    synthetic({
      buildLiveActivityConversationItems: live.buildLiveActivityConversationItems,
      isFreshLodyPresenceState: () => false,
      isConvexUnauthenticatedError: sharedAuth.isConvexUnauthenticatedError,
      HANDLED_SHORTCUT_TOKEN_ERROR: sharedAuth.HANDLED_SHORTCUT_TOKEN_ERROR,
      hashAnalyticsId: (value) => value,
      normalizePersistedRateLimit: rateLimits.normalizePersistedRateLimit,
      isSubscriptionQuotaEligible: subscriptionQuota.isSubscriptionQuotaEligible,
      CODEX_SPARK_LIMIT_ID: schema.CODEX_SPARK_LIMIT_ID,
      parseRateLimitEntryKey: schema.parseRateLimitEntryKey,
    })
  );
  const corePath = path.join(repo, 'apps/mobile-capacitor/src/home-widget-core.ts');
  const core = await evaluate(corePath);
  files.set(
    corePath,
    synthetic({
      ...core,
      createHomeWidgetSync(options) {
        const sync = core.createHomeWidgetSync(options);
        syncOwners.add(sync);
        return sync;
      },
    })
  );
  const authModule = await evaluate(path.join(componentsPath, 'lib/auth.ts'));
  const runtime = await evaluate(path.join(componentsPath, 'atoms/runtime.ts'));
  const workspace = await evaluate(path.join(componentsPath, 'atoms/workspace-context.ts'));
  const home = await evaluate(path.join(repo, 'apps/mobile-capacitor/src/home-widget.ts'));
  AuthContext = (await evaluate(path.join(componentsPath, 'hooks/use-authenticated-convex.ts')))
    .AuthenticatedConvexContext;
  const tokenAdapter = await evaluate(
    path.join(repo, 'apps/mobile-capacitor/src/token-usage-widget.tsx')
  );
  let owner;
  function setOwner({
    id = userId,
    token = 'synthetic-token-a',
    accountId = id,
    task = title,
  } = {}) {
    owner = {
      workspaceId,
      workspaceSlug,
      accountId,
      contentMode: 'plaintext',
      requestProviderRateLimitsRefresh: (machineId, configId) => quotaRefresh(machineId, configId),
    };
    store.set(userAtom, { id });
    store.set(runtime.authTokenAtom, token);
    store.set(workspace.setWorkspaceContextAtom, { slug: workspaceSlug, workspaceId });
    store.set(runtime.runtimeAtom, owner);
    store.set(metadataAtom, { ...owner, runtime: owner, ready: true });
    store.set(sessionsAtom, [
      {
        id: 'session-synthetic',
        userId: id,
        title: task,
        awaitingUserSince: 1,
        lastMessageAt: now,
        agentType: 'codex',
        cliType: 'builtin',
      },
    ]);
  }
  setOwner();
  const originalRoute = () => React.createElement('div', null, 'original route');
  const route = {
    options: { component: originalRoute },
    update(options) {
      Object.assign(this.options, options);
    },
  };
  const router = { routesById: { '/$workspaceName/_auth': route } };
  let disposeHome;
  let disposeToken;
  let disposeQuota;
  let disposal;
  let closed = false;
  const render = (mounted = true) =>
    React.act(async () => {
      root.render(
        mounted
          ? React.createElement(
              Jotai.Provider,
              { store },
              React.createElement(
                AuthContext.Provider,
                { value: auth },
                React.createElement(route.options.component)
              )
            )
          : null
      );
    });
  const idle = () => Promise.all([...syncOwners].map((sync) => sync.whenIdle()));

  return {
    cache,
    store,
    userAtom,
    runtime,
    scopeAtom: home.homeWidgetScopeAtom,
    credentials,
    setQuotaRefresh(handler) {
      quotaRefresh = handler;
    },
    async setQuotaSources({ machines, configs, online = [], locale = 'en' }) {
      await React.act(async () => {
        store.set(machinesAtom, new Map(machines.map((machine) => [machine.id, machine])));
        store.set(configsAtom, configs);
        store.set(onlineAtom, new Set(online));
        store.set(localeAtom, locale);
      });
    },
    async setMetadataReady(ready) {
      await React.act(async () => store.set(metadataAtom, { ...store.get(metadataAtom), ready }));
    },
    async startQuota() {
      const adapter = await evaluate(
        path.join(repo, 'apps/mobile-capacitor/src/provider-quota-widget.ts')
      );
      await React.act(async () => {
        disposeQuota = adapter.initProviderQuotaWidget();
      });
    },
    async start() {
      disposeHome = home.initHomeWidgetSync(authClient);
      disposeToken = tokenAdapter.initTokenUsageWidget(router);
      disposal = undefined;
      await render();
      await idle();
    },
    signOut() {
      signingOut = authModule.signOutWithoutRedirect(authClient);
      return signingOut;
    },
    finishSignOut(response = { error: null }) {
      signOutFinished.resolve(response);
      return signingOut;
    },
    change: (callback) => React.act(async () => callback()),
    async restoreOwner(options) {
      await React.act(async () => setOwner(options));
    },
    async setTask(task) {
      await React.act(async () => {
        store.set(
          sessionsAtom,
          store.get(sessionsAtom).map((session) => ({ ...session, title: task }))
        );
      });
    },
    async setAuth(update) {
      auth = { ...auth, ...update };
      await render();
    },
    async publishUsage(tokens, { sessionId = auth.authSessionId, id = workspaceId } = {}) {
      await React.act(async () => {
        queryResults.set(queryKey(sessionId, id), {
          workspaceId: id,
          range: 'day',
          startMs: Date.UTC(2026, 9, 14),
          endMs: now,
          bucketSizeMs: 3_600_000,
          totals: { tokens },
          buckets: [],
        });
        for (const notify of queryListeners) notify();
      });
    },
    async appState(isActive) {
      await React.act(async () => {
        for (const listener of listeners) listener({ isActive });
      });
    },
    async advance(ms = 250) {
      await React.act(async () => advanceTimers(ms));
    },
    async flush(ms = 250) {
      await React.act(async () => advanceTimers(ms));
      await idle();
    },
    blockNextWrite(kind) {
      const started = deferred();
      const finished = deferred();
      releases.add(finished.resolve);
      blockedWrites.set(kind, { started, finished });
      return { started: started.promise, finish: finished.resolve };
    },
    failNextWrite(kind, { afterWrite = false } = {}) {
      const started = deferred();
      failedWrites.set(kind, { started, afterWrite });
      return started.promise;
    },
    stopPublishers() {
      if (!disposal) {
        disposal = Promise.all([disposeHome?.(), disposeToken?.(), disposeQuota?.()]);
        disposeHome = undefined;
        disposeToken = undefined;
        disposeQuota = undefined;
      }
      return disposal;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const release of releases) release();
      signOutFinished.resolve({ error: null });
      if (signingOut) await signingOut;
      await this.stopPublishers();
      await React.act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}
