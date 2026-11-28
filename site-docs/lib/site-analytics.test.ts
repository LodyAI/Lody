import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyConversionHref,
  classifyInstallCommand,
  deriveLandingAttribution,
  EUROPE_CONSENT_REGIONS,
  requiresRegionalCookieConsentFromEnv,
} from './site-analytics.ts';

await test('regional cookie consent prompts only in EEA, UK, and Switzerland', () => {
  assert.equal(EUROPE_CONSENT_REGIONS.length, 32);
  assert.ok(EUROPE_CONSENT_REGIONS.includes('DE'));
  assert.ok(EUROPE_CONSENT_REGIONS.includes('GB'));
  assert.ok(EUROPE_CONSENT_REGIONS.includes('CH'));

  // EEA / UK / CH timezones require consent when no cookie override is present.
  assert.equal(requiresRegionalCookieConsentFromEnv({ timeZone: 'Europe/Berlin' }), true);
  assert.equal(requiresRegionalCookieConsentFromEnv({ timeZone: 'Europe/London' }), true);
  assert.equal(requiresRegionalCookieConsentFromEnv({ timeZone: 'Europe/Zurich' }), true);
  assert.equal(requiresRegionalCookieConsentFromEnv({ timeZone: 'Atlantic/Reykjavik' }), true);

  // Non-EEA Europe/* timezones (e.g. Russia, Turkey, Ukraine) and non-European regions default to granted.
  assert.equal(requiresRegionalCookieConsentFromEnv({ timeZone: 'Europe/Moscow' }), false);
  assert.equal(requiresRegionalCookieConsentFromEnv({ timeZone: 'Europe/Istanbul' }), false);
  assert.equal(requiresRegionalCookieConsentFromEnv({ timeZone: 'Europe/Kyiv' }), false);
  assert.equal(requiresRegionalCookieConsentFromEnv({ timeZone: 'America/Los_Angeles' }), false);
  assert.equal(requiresRegionalCookieConsentFromEnv({ timeZone: 'Asia/Shanghai' }), false);
  assert.equal(requiresRegionalCookieConsentFromEnv({ timeZone: 'Asia/Tokyo' }), false);
  assert.equal(requiresRegionalCookieConsentFromEnv({ timeZone: 'Asia/Seoul' }), false);

  // Edge cookie takes precedence over client timezone.
  assert.equal(
    requiresRegionalCookieConsentFromEnv({
      cookieHeader: 'lody-consent-region=US',
      timeZone: 'Europe/Berlin',
    }),
    false
  );
  assert.equal(
    requiresRegionalCookieConsentFromEnv({
      cookieHeader: 'lody-consent-region=FR',
      timeZone: 'America/New_York',
    }),
    true
  );
  assert.equal(
    requiresRegionalCookieConsentFromEnv({
      cookieHeader: 'lody-consent-region=other',
      timeZone: 'Europe/Paris',
    }),
    false
  );
});

await test('deriveLandingAttribution classifies organic search, AI referrals, UTM, paid, and direct entries without leaking query tokens', () => {
  assert.deepEqual(
    deriveLandingAttribution({
      href: 'https://lody.ai/blog/handoff-claude-code-session?secret=should-not-leak#top',
      referrer: 'https://www.google.com/search?q=share+claude+code+session',
    }),
    {
      entry_page: '/blog/handoff-claude-code-session/',
      entry_locale: 'en',
      traffic_channel: 'organic_search',
      referrer_host: 'www.google.com',
    }
  );

  assert.deepEqual(
    deriveLandingAttribution({
      href: 'https://lody.ai/ja/docs/worktrees/',
      referrer: 'https://search.yahoo.co.jp/',
    }),
    {
      entry_page: '/ja/docs/worktrees/',
      entry_locale: 'ja',
      traffic_channel: 'organic_search',
      referrer_host: 'search.yahoo.co.jp',
    }
  );

  assert.deepEqual(
    deriveLandingAttribution({
      href: 'https://lody.ai/zh/docs/quickstart/',
      referrer: 'https://www.baidu.com/link?url=123',
    }),
    {
      entry_page: '/zh/docs/quickstart/',
      entry_locale: 'zh',
      traffic_channel: 'organic_search',
      referrer_host: 'www.baidu.com',
    }
  );

  assert.deepEqual(
    deriveLandingAttribution({
      href: 'https://lody.ai/docs/session-handoff/',
      referrer: 'https://chatgpt.com/',
    }),
    {
      entry_page: '/docs/session-handoff/',
      entry_locale: 'en',
      traffic_channel: 'ai_referral',
      referrer_host: 'chatgpt.com',
    }
  );

  assert.deepEqual(
    deriveLandingAttribution({
      href: 'https://lody.ai/?utm_source=producthunt&utm_medium=launch&utm_campaign=v1',
      referrer: 'https://www.producthunt.com/',
    }),
    {
      entry_page: '/',
      entry_locale: 'en',
      traffic_channel: 'utm',
      referrer_host: 'www.producthunt.com',
      utm_source: 'producthunt',
      utm_medium: 'launch',
      utm_campaign: 'v1',
    }
  );

  assert.deepEqual(
    deriveLandingAttribution({
      href: 'https://lody.ai/?gclid=test123',
      referrer: 'https://www.google.com/',
    }),
    {
      entry_page: '/',
      entry_locale: 'en',
      traffic_channel: 'paid_search',
      referrer_host: 'www.google.com',
    }
  );

  // Same-site referrer is treated as direct, not external referral.
  assert.deepEqual(
    deriveLandingAttribution({
      href: 'https://lody.ai/download/',
      referrer: 'https://lody.ai/docs/quickstart/',
    }),
    {
      entry_page: '/download/',
      entry_locale: 'en',
      traffic_channel: 'direct',
      referrer_host: '(none)',
    }
  );
});

await test('classifyConversionHref covers stable/nightly installers, mobile stores, /login, and founder calls', () => {
  assert.deepEqual(
    classifyConversionHref('https://updates.lody.ai/production/Lody-0.117.0-arm64.dmg'),
    {
      event: 'download_installer',
      platform: 'mac',
      arch: 'arm64',
      installer_format: 'dmg',
      release_channel: 'stable',
    }
  );

  assert.deepEqual(
    classifyConversionHref('https://updates.lody.ai/production/Lody-latest-x64.dmg'),
    {
      event: 'download_installer',
      platform: 'mac',
      arch: 'x64',
      installer_format: 'dmg',
      release_channel: 'stable',
    }
  );

  assert.deepEqual(
    classifyConversionHref('https://updates.lody.ai/production/Lody-latest-x64-setup.exe'),
    {
      event: 'download_installer',
      platform: 'win',
      arch: 'x64',
      installer_format: 'exe',
      release_channel: 'stable',
    }
  );

  assert.deepEqual(
    classifyConversionHref('https://updates.lody.ai/production/Lody-latest-x86_64.AppImage'),
    {
      event: 'download_installer',
      platform: 'linux',
      arch: 'x64',
      installer_format: 'appimage',
      release_channel: 'stable',
    }
  );

  assert.deepEqual(
    classifyConversionHref('https://updates.lody.ai/production/Lody-0.117.0-arm64.deb'),
    {
      event: 'download_installer',
      platform: 'linux',
      arch: 'arm64',
      installer_format: 'deb',
      release_channel: 'stable',
    }
  );

  assert.deepEqual(
    classifyConversionHref('https://updates.lody.ai/mobile/production/lody-android-latest.apk'),
    {
      event: 'download_installer',
      platform: 'android',
      arch: 'universal',
      installer_format: 'apk',
      release_channel: 'stable',
    }
  );

  assert.deepEqual(
    classifyConversionHref('https://cdn.example.com/nightly/Lody-0.118.0-nightly.1-arm64.dmg', {
      nightlyBaseUrl: 'https://cdn.example.com/nightly',
    }),
    {
      event: 'download_installer',
      platform: 'mac',
      arch: 'arm64',
      installer_format: 'dmg',
      release_channel: 'nightly',
    }
  );

  assert.deepEqual(classifyConversionHref('https://apps.apple.com/cn/app/lody/id6761373528'), {
    event: 'download_installer',
    platform: 'ios',
    arch: 'universal',
    installer_format: 'app_store',
    release_channel: 'stable',
  });

  assert.deepEqual(
    classifyConversionHref('https://play.google.com/store/apps/details?id=ai.lody.android'),
    {
      event: 'download_installer',
      platform: 'android',
      arch: 'universal',
      installer_format: 'google_play',
      release_channel: 'stable',
    }
  );

  assert.deepEqual(classifyConversionHref('/login?next=%2Fapp'), {
    event: 'open_web_app',
    destination: '/login',
  });

  assert.deepEqual(
    classifyConversionHref('https://calendar.notion.so/meet/remch183/hqic3xqu?utm_source=pricing'),
    {
      event: 'book_founder_call',
      booking_source: 'pricing',
    }
  );

  assert.equal(classifyConversionHref('/docs/quickstart/'), null);
  assert.equal(classifyConversionHref('https://github.com/LodyAI/lody'), null);
});

await test('classifyInstallCommand detects npx lody and homebrew cask commands without leaking other text', () => {
  assert.deepEqual(classifyInstallCommand('npx lody daemon start'), {
    event: 'copy_install_command',
    install_method: 'npx_lody',
  });
  assert.deepEqual(classifyInstallCommand('brew install --cask lody'), {
    event: 'copy_install_command',
    install_method: 'homebrew',
  });
  assert.equal(classifyInstallCommand('git status --short'), null);
});
