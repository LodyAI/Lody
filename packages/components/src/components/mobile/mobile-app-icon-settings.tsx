import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { Button } from '@/ui/button';
import { MobileSettingsSection } from './mobile-settings-row';

export type AppIconState = { supported: boolean; name: string };
export type AppIconBridge = {
  icons: readonly { name: string; displayName?: string; previewUrl: string }[];
  getState: () => Promise<AppIconState>;
  setIcon: (options: { name: string }) => Promise<AppIconState>;
};

export function MobileAppIconSettings({
  bridge = typeof window === 'undefined'
    ? undefined
    : (window as Window & { __LODY_APP_ICON__?: AppIconBridge }).__LODY_APP_ICON__,
}: {
  bridge?: AppIconBridge;
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
      setState(await bridge.setIcon({ name }));
    } catch {
      setError(true);
    } finally {
      changing.current = false;
      setPending(false);
    }
  }

  return (
    <MobileSettingsSection title={t('settings.appIcon.title')}>
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
              variant="outline"
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
    </MobileSettingsSection>
  );
}
