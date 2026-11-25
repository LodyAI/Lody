import * as stylex from '@stylexjs/stylex';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { themeColors } from '../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../style/theme-scale.stylex';
import { isElectronRenderer } from '../lib/electron';
import { isNativeAppShell } from '../lib/native-platform';

export const WEB_COOKIE_CONSENT_KEY = 'lody:cookie-consent';

type CookieConsentDecision = 'granted' | 'denied';

type GtagWindow = Window & {
  gtag?: (...args: unknown[]) => void;
};

export function readWebCookieConsent(): CookieConsentDecision | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(WEB_COOKIE_CONSENT_KEY);
    return value === 'granted' || value === 'denied' ? value : null;
  } catch {
    return null;
  }
}

export function writeWebCookieConsent(decision: CookieConsentDecision): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(WEB_COOKIE_CONSENT_KEY, decision);
  } catch {
    // Storage may be blocked; still update in-page consent state.
  }
  const gtag = (window as GtagWindow).gtag;
  if (typeof gtag === 'function') {
    gtag('consent', 'update', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: decision,
    });
  }
}

const styles = stylex.create({
  banner: {
    position: 'fixed',
    bottom: themeSpace[4],
    right: themeSpace[4],
    left: {
      default: themeSpace[4],
      '@media (min-width: 640px)': 'auto',
    },
    width: {
      default: 'auto',
      '@media (min-width: 640px)': 420,
    },
    maxWidth: 'calc(100vw - 32px)',
    zIndex: 60,
    borderRadius: themeRadius.lg,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: themeColors.border,
    backgroundColor: themeColors.popover,
    color: themeColors.popoverForeground,
    padding: themeSpace[4],
    boxShadow: '0 8px 30px rgba(0, 0, 0, 0.2)',
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[3],
  },
  title: {
    margin: 0,
    fontSize: themeFontSize.sm,
    fontWeight: themeFontWeight.semibold,
    lineHeight: themeLineHeight.sm,
    color: themeColors.foreground,
  },
  description: {
    margin: 0,
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: themeSpace[2],
  },
});

export function WebCookieConsentBanner() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isElectronRenderer() || isNativeAppShell()) return;
    setVisible(readWebCookieConsent() === null);
  }, []);

  if (!visible) return null;

  const decide = (decision: CookieConsentDecision) => {
    writeWebCookieConsent(decision);
    setVisible(false);
  };

  return (
    <aside role="region" aria-label={t('cookieConsent.title')} {...stylex.props(styles.banner)}>
      <p {...stylex.props(styles.title)}>{t('cookieConsent.title')}</p>
      <p {...stylex.props(styles.description)}>{t('cookieConsent.description')}</p>
      <div {...stylex.props(styles.actions)}>
        <Button variant="secondary" onClick={() => decide('denied')}>
          {t('cookieConsent.reject')}
        </Button>
        <Button variant="primary" onClick={() => decide('granted')}>
          {t('cookieConsent.accept')}
        </Button>
      </div>
    </aside>
  );
}
