export let LODY_AUTH_URL = process.env.LODY_AUTH_URL;
export let LODY_AUTH_SITE_URL = process.env.LODY_AUTH_SITE_URL;
export let LODY_SERVER_URL = process.env.LODY_SERVER_URL;
export let SITE_URL = process.env.SITE_URL ?? 'https://lody.ai';
export let SITE_APP_BASE_PATH = '';

export const loadEnv = () => {
  LODY_AUTH_URL = process.env['LODY_AUTH_URL'];
  LODY_AUTH_SITE_URL = process.env['LODY_AUTH_SITE_URL'];
  LODY_SERVER_URL = process.env['LODY_SERVER_URL'];
  SITE_URL = process.env['SITE_URL'] ?? 'https://lody.ai';
  SITE_APP_BASE_PATH = process.env['SITE_APP_BASE_PATH'] ?? '';
};
