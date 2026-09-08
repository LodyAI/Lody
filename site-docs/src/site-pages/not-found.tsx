import { localeFromPathname, notFoundCopy, type NotFoundSeoLocale } from '@site/lib/not-found-seo';
import { useLocation } from '@tanstack/react-router';

/**
 * Lives in its own module because `src/routes/__root.tsx` wires it as the global
 * `notFoundComponent`. The root route is on EVERY page, so anything it imports is
 * in the common chunk — when this sat in the old `src/site-pages.tsx` barrel it
 * dragged the docs layout, blog, changelog and pricing pages onto the landing.
 */
export function SiteNotFound() {
  return <NotFoundPage />;
}

export function NotFoundPage({ locale }: { locale?: NotFoundSeoLocale }) {
  const location = useLocation();
  const resolved = locale ?? localeFromPathname(location.pathname);
  const copy = notFoundCopy[resolved];

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-sm font-medium uppercase tracking-[0.22em] text-fd-muted-foreground">
        404
      </p>
      <h1 className="text-3xl font-semibold">{copy.heading}</h1>
      <p className="max-w-md text-fd-muted-foreground">{copy.description}</p>
      <p className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
        <a className="text-sm font-medium text-fd-primary hover:underline" href={copy.homeHref}>
          {copy.home}
        </a>
        <a className="text-sm font-medium text-fd-primary hover:underline" href={copy.docsHref}>
          {copy.docs}
        </a>
      </p>
    </main>
  );
}
