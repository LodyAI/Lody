import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Firebase client configuration is not an Admin service-account credential.
const configPath = fileURLToPath(new URL('../android/app/google-services.json', import.meta.url));
const raw = process.env.PUSH_ANDROID_GOOGLE_SERVICES_JSON;
let source = raw;
if (!source) {
  try {
    source = await readFile(configPath, 'utf8');
  } catch {
    throw new Error(
      'Android push requires PUSH_ANDROID_GOOGLE_SERVICES_JSON or android/app/google-services.json'
    );
  }
}
let value;
try {
  value = JSON.parse(source);
} catch {
  // JSON.parse errors may include input bytes. Never expose config in CI logs.
  throw new Error('Firebase Android client configuration must be valid JSON');
}
if (!value || typeof value !== 'object' || value.private_key || value.type === 'service_account')
  throw new Error('Expected Firebase Android CLIENT google-services.json, never a service account');
const client = Array.isArray(value.client)
  ? value.client.find(
      (entry) => entry?.client_info?.android_client_info?.package_name === 'ai.lody.android'
    )
  : undefined;
if (!client) throw new Error('Firebase configuration must contain Android package ai.lody.android');
const nonempty = (input) => typeof input === 'string' && input.trim().length > 0;
if (
  !nonempty(value.project_info?.project_id) ||
  !/^\d+$/.test(value.project_info?.project_number ?? '') ||
  !client.client_info.mobilesdk_app_id?.startsWith(
    `1:${value.project_info.project_number}:android:`
  ) ||
  !Array.isArray(client.api_key) ||
  !client.api_key.some((key) => nonempty(key?.current_key))
)
  throw new Error('Firebase Android client configuration is missing project, app ID or API key');

if (raw) {
  await mkdir(fileURLToPath(new URL('../android/app/', import.meta.url)), { recursive: true });
  await writeFile(configPath, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
console.log('Android Firebase client configuration validated.');
