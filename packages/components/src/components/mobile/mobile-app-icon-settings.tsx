import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { deferredPostHog } from '@/lib/deferred-posthog';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { MobileSettingsSection } from './mobile-settings-row';
import { CompactSection } from '../settings/compact-layout';

export type AppIconState = { supported: boolean; name: string };
export type AppIconBridge = {
  icons: readonly { name: string; displayName?: string; previewUrl: string }[];
  getState: () => Promise<AppIconState>;
  setIcon: (options: { name: string }) => Promise<AppIconState>;
};

// Native icon identifiers differ per host (iOS `AppIconBlue`, macOS `aqua`);
// analytics only reports the product-level enum, never an unknown raw name.
function appIconAnalyticsValue(name: string): 'aqua' | 'default' | null {
  if (name === 'default') return 'default';
  if (name === 'AppIconBlue' || name === 'aqua') return 'aqua';
  return null;
}

export function MobileAppIconSettings({
  layout = 'mobile',
  bridge = typeof window === 'undefined'
    ? undefined
    : (window as Window & { __LODY_APP_ICON__?: AppIconBridge }).__LODY_APP_ICON__,
}: {
  bridge?: AppIconBridge;
  layout?: 'mobile' | 'desktop';
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<AppIconState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const changing = useRef(false);

  useEffect(() => {
    if (!bridge) return undefined;
    let active = true;
    setState(null);
    setError(false);
    void bridge.getState().then(
      (next) => {
        if (active) setState(next);
      },
      () => {
        if (active) setError(true);
      }
    );
    return () => {
      active = false;
    };
  }, [bridge, reload]);

  if (!bridge || state?.supported === false) return null;

  async function selectIcon(name: string) {
    if (!bridge || !state?.supported || changing.current || name === state.name) return;
    changing.current = true;
    setPending(true);
    setError(false);
    try {
      // Native state is authoritative; a rejected change must keep the old checkmark.
      const next = await bridge.setIcon({ name });
      setState(next);
      const value = appIconAnalyticsValue(next.name);
      if (value && next.name === name) {
        capturePostHogEvent(deferredPostHog, 'settings/changed', { key: 'app_icon', value });
      }
    } catch {
      setError(true);
    } finally {
      changing.current = false;
      setPending(false);
    }
  }

  const Section = layout === 'desktop' ? CompactSection : MobileSettingsSection;
  return (
    <Section title={t('settings.appIcon.title')}>
      <div className="flex flex-wrap gap-3 p-4" aria-busy={pending || (!state && !error)}>
        {bridge.icons.map((icon, index) => {
          const selected = state?.name === icon.name;
          const label =
            icon.name === 'default'
              ? t('settings.appIcon.default')
              : (icon.displayName ?? t('settings.appIcon.alternate', { number: index + 1 }));
          return (
            <Button
              key={icon.name}
              variant="secondary"
              className="h-auto min-w-24 flex-col gap-2 p-3"
              aria-pressed={selected}
              disabled={!state || pending}
              onClick={() => void selectIcon(icon.name)}
            >
              <img src={icon.previewUrl} alt="" width={64} height={64} className="rounded-2xl" />
              <span className="flex items-center gap-1">
                {label}
                {selected ? <Check className="size-3.5" aria-hidden="true" /> : null}
              </span>
            </Button>
          );
        })}
      </div>
      {error ? (
        <div className="px-4 pb-3">
          <p role="alert" className="text-sm text-destructive">
            {t('settings.appIcon.error')}
          </p>
          {!state ? (
            <Button variant="ghost" onClick={() => setReload((value) => value + 1)}>
              {t('common.retry')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
