import { useTranslation } from 'react-i18next';
import { LogIn } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/ui/avatar';
import { Button } from '@/ui/button';

/**
 * Who is looking at this share, as far as the reader can tell.
 *
 * The reader never authenticates: it holds no workspace credential and, in
 * production, is served from its own origin, so it cannot read the app's
 * session cookie. The host supplies this when it can establish an identity;
 * `signed-out` is the honest default and the only state the isolated share
 * origin can reach today.
 */
export type ShareViewer =
  | { status: 'signed-out' }
  | { status: 'signed-in'; name: string; imageUrl?: string | null };

/** The app origin to send a visitor to, or null when it cannot be established. */
export function resolveShareAppOrigin(): string | null {
  const configured = import.meta.env.VITE_SITE_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      /* Fall through to the address the visitor is already on. */
    }
  }
  if (typeof window === 'undefined') return null;
  const { hostname, protocol, port } = window.location;
  // A dedicated share subdomain has no sign-in page of its own.
  if (hostname.startsWith('share.') && hostname.split('.').length > 2) {
    return `${protocol}//${hostname.slice('share.'.length)}${port ? `:${port}` : ''}`;
  }
  return window.location.origin;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts.length === 1 ? parts[0]!.slice(0, 2) : parts[0]![0]! + parts.at(-1)![0]!)
    .toUpperCase()
    .slice(0, 2);
}

/** Top-right identity slot: the signed-in visitor, or a way to go and sign in. */
export function ShareViewerIdentity({
  viewer,
  appOrigin,
}: {
  viewer: ShareViewer;
  appOrigin: string | null;
}) {
  const { t } = useTranslation();
  if (viewer.status === 'signed-in')
    return (
      <div className="flex min-w-0 items-center gap-2 pl-1">
        <span className="hidden min-w-0 max-w-40 truncate text-xs text-muted-foreground sm:block">
          {viewer.name}
        </span>
        <Avatar className="size-6">
          {viewer.imageUrl ? <AvatarImage src={viewer.imageUrl} alt="" /> : null}
          <AvatarFallback className="text-[10px] font-medium">
            {initialsOf(viewer.name)}
          </AvatarFallback>
        </Avatar>
      </div>
    );
  if (!appOrigin) return null;
  return (
    <Button asChild size="sm" variant="outline" className="h-8">
      {/* A new tab: signing in must never navigate away from the shared page. */}
      <a
        href={`${appOrigin}/login`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t('sharing.signIn', 'Sign in to Lody')}
      >
        <LogIn className="size-3.5" aria-hidden />
        <span className="hidden sm:inline">{t('sharing.signIn', 'Sign in to Lody')}</span>
      </a>
    </Button>
  );
}
