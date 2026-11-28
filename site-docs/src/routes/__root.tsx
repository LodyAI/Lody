import '@site/app/global.css';
import { SiteRootProvider } from '@site/components/site-root-provider';
import { EUROPE_CONSENT_REGIONS } from '@site/lib/site-analytics';
import { SiteNotFound } from '@site/src/site-pages/not-found';
import { detectSiteLocaleFromPath, htmlLangForLocale } from '@site/src/site-pages/shared';
import { createRootRoute, HeadContent, Outlet, Scripts, useLocation } from '@tanstack/react-router';

const description =
  'Lody is an AI coding-agent workspace for running multiple agents in parallel with isolated Git worktrees, real-time diff review, GitHub integration, mobile access, and team collaboration.';
const googleAnalyticsMeasurementId = 'G-JSXEKG6RRV';

const gaConsentModeV2Script = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}window.gtag=gtag;
gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied',functionality_storage:'granted',security_storage:'granted',region:${JSON.stringify(EUROPE_CONSENT_REGIONS)},wait_for_update:500});
gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'granted',functionality_storage:'granted',security_storage:'granted'});
try{var c=window.localStorage.getItem('lody:cookie-consent');if(c==='granted'||c==='denied'){gtag('consent','update',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:c});}}catch(e){}
gtag('js',new Date());
gtag('config','${googleAnalyticsMeasurementId}',{anonymize_ip:true,page_location:window.location.href,page_path:window.location.pathname,page_referrer:document.referrer});
window.addEventListener('load',function(){var s=document.createElement('script');s.async=true;s.src='https://www.googletagmanager.com/gtag/js?id=${googleAnalyticsMeasurementId}';document.head.appendChild(s);});`;

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
        children: gaConsentModeV2Script,
      },
    ],
  }),
  component: RootDocument,
  notFoundComponent: SiteNotFound,
});

function RootDocument() {
  const location = useLocation();
  const lang = htmlLangForLocale(detectSiteLocaleFromPath(location.pathname));

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
