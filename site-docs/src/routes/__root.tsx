import '@site/app/global.css';
import { SiteRootProvider } from '@site/components/site-root-provider';
import { SiteNotFound } from '@site/src/site-pages/not-found';
import { createRootRoute, HeadContent, Outlet, Scripts, useLocation } from '@tanstack/react-router';

const description =
  'Lody is an AI coding-agent workspace for running multiple agents in parallel with isolated Git worktrees, real-time diff review, GitHub integration, mobile access, and team collaboration.';
const googleAnalyticsMeasurementId = 'G-JSXEKG6RRV';
const vibeloftAuthKey = import.meta.env.VITE_VIBELOFT_WEB_AUTH_KEY?.trim();

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Lody Docs' },
      { name: 'description', content: description },
      { name: 'apple-itunes-app', content: 'app-id=6761373528' },
      { property: 'og:site_name', content: 'Lody' },
      { property: 'og:type', content: 'website' },
      { property: 'og:image', content: 'https://lody.ai/og-image.png' },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:image', content: 'https://lody.ai/og-image.png' },
    ],
    links: [
      { rel: 'icon', href: '/favicon.ico', sizes: 'any' },
      { rel: 'icon', href: '/favicon-light.svg', type: 'image/svg+xml' },
      {
        rel: 'icon',
        href: '/favicon-dark.svg',
        type: 'image/svg+xml',
        media: '(prefers-color-scheme: dark)',
      },
      { rel: 'apple-touch-icon', href: '/_docs-assets/logo-180.png' },
    ],
    scripts: [
      {
        children: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}
window.addEventListener('load',function(){var s=document.createElement('script');s.async=true;s.src='https://www.googletagmanager.com/gtag/js?id=${googleAnalyticsMeasurementId}';s.onload=function(){gtag('js',new Date());gtag('config','${googleAnalyticsMeasurementId}');};document.head.appendChild(s);});`,
      },
      ...(vibeloftAuthKey
        ? [
            {
              defer: true,
              src: 'https://vibeloft.ai/telemetry/v1.js',
              'data-vl-product-id': '791c7291-4457-4767-93e2-212a37340f20',
              'data-vl-auth-key': vibeloftAuthKey,
            },
          ]
        : []),
    ],
  }),
  component: RootDocument,
  notFoundComponent: SiteNotFound,
});

function RootDocument() {
  const location = useLocation();
  const lang = location.pathname === '/zh' || location.pathname.startsWith('/zh/') ? 'zh-CN' : 'en';

  return (
    <html lang={lang} suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="flex min-h-screen flex-col">
        <SiteRootProvider>
          <Outlet />
        </SiteRootProvider>
        <Scripts />
      </body>
    </html>
  );
}
