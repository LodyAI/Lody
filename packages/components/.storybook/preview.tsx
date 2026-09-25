import type { Preview } from '@storybook/react-vite';
import React, { useEffect } from 'react';
import {
  Outlet,
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { ConvexProvider, ConvexReactClient } from 'convex/react';
import '../src/tailwind/index.css';
import {
  AuthenticatedConvexContext,
  type AuthenticatedConvexContextValue,
} from '../src/hooks/use-authenticated-convex';
import { ThemeProvider } from '../src/theme-provider';
import { Tooltip } from '@lody/ui/tooltip';
import { I18nextProvider } from 'react-i18next';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { resources, defaultNS } from '../src/i18n';

function RouterOutlet() {
  return <Outlet />;
}

function EmptyRouteComponent() {
  return null;
}

const rootRoute = createRootRoute({
  component: RouterOutlet,
});

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '$workspaceName',
  component: RouterOutlet,
});

const settingsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'settings',
  component: RouterOutlet,
});

const settingsGeneralRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'general',
  component: EmptyRouteComponent,
});

const settingsIntegrationsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'integrations',
  component: EmptyRouteComponent,
});

const chatRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'chat',
  component: EmptyRouteComponent,
});

const sessionsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'sessions',
  component: RouterOutlet,
});

const sessionsActiveRoute = createRoute({
  getParentRoute: () => sessionsRoute,
  path: 'active',
  component: EmptyRouteComponent,
});

const machinesRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'machines',
  component: EmptyRouteComponent,
});

const routeTree = rootRoute.addChildren([
  workspaceRoute.addChildren([
    chatRoute,
    sessionsRoute.addChildren([sessionsActiveRoute]),
    machinesRoute,
    settingsRoute.addChildren([settingsGeneralRoute, settingsIntegrationsRoute]),
  ]),
]);

const storybookRouter = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ['/storybook/chat'] }),
  context: {},
});

const storybookConvexUrl = (import.meta.env as unknown as { VITE_CONVEX_DEPLOY_URL?: string })
  .VITE_CONVEX_DEPLOY_URL;

const storybookConvexClient = new ConvexReactClient(
  storybookConvexUrl && storybookConvexUrl.length > 0 ? storybookConvexUrl : 'http://127.0.0.1:3210'
);

// Stories have no auth backend; report a settled signed-out state so hooks
// gated on useAuthenticatedConvex render their offline path instead of throwing.
const storybookAuthValue: AuthenticatedConvexContextValue = {
  authSessionId: null,
  isAuthenticated: false,
  isLoading: false,
  isRecovering: false,
  confirmedUnauthenticated: true,
  claimAutomaticCommand: () => false,
  requestAuthRecovery: () => {},
};

// Initialize i18n
void i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  defaultNS,
  ns: [defaultNS],
  debug: false,
  resources,
  interpolation: {
    escapeValue: false,
  },
});

const preview: Preview = {
  decorators: [
    (Story, context) => {
      const theme = context.globals.theme || 'light';
      const locale = context.globals.locale || 'en';

      useEffect(() => {
        void i18next.changeLanguage(locale);
      }, [locale]);

      return (
        <ConvexProvider client={storybookConvexClient}>
          <AuthenticatedConvexContext.Provider value={storybookAuthValue}>
            <RouterContextProvider router={storybookRouter}>
              <I18nextProvider i18n={i18next}>
                <ThemeProvider
                  key={`storybook-theme-${theme}`}
                  defaultTheme={theme}
                  storageKey="storybook-theme"
                >
                  <Tooltip.Provider>
                    <div className="h-full bg-background text-foreground">
                      <Story />
                    </div>
                  </Tooltip.Provider>
                </ThemeProvider>
              </I18nextProvider>
            </RouterContextProvider>
          </AuthenticatedConvexContext.Provider>
        </ConvexProvider>
      );
    },
  ],
  globalTypes: {
    theme: {
      name: 'Theme',
      description: 'Global theme for components',
      defaultValue: 'light',
      toolbar: {
        icon: 'circlehollow',
        items: [
          { value: 'light', icon: 'sun', title: 'Light' },
          { value: 'dark', icon: 'moon', title: 'Dark' },
          { value: 'system', icon: 'browser', title: 'System' },
        ],
        showName: true,
      },
    },
    locale: {
      name: 'Locale',
      description: 'Internationalization locale',
      defaultValue: 'en',
      toolbar: {
        icon: 'globe',
        items: [
          { value: 'en', right: '🇺🇸', title: 'English' },
          { value: 'zh_CN', right: '🇨🇳', title: 'Chinese' },
        ],
        showName: true,
      },
    },
  },
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
};

export default preview;
