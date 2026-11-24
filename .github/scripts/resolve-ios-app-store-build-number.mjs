#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { sign } from 'node:crypto';

const ASC_API_BASE_URL = process.env.ASC_API_BASE_URL ?? 'https://api.appstoreconnect.apple.com';
const IOS_PLATFORM = 'IOS';

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createAppStoreConnectJwt() {
  const keyId = requiredEnv('APPLE_API_KEY_ID');
  const issuerId = requiredEnv('APPLE_API_ISSUER');
  const privateKey = process.env.APPLE_API_KEY_PATH
    ? readFileSync(process.env.APPLE_API_KEY_PATH, 'utf8')
    : requiredEnv('APPLE_API_KEY_P8');
  const now = Math.floor(Date.now() / 1000);
  const signingInput = [
    base64UrlJson({ alg: 'ES256', kid: keyId, typ: 'JWT' }),
    base64UrlJson({
      aud: 'appstoreconnect-v1',
      exp: now + 20 * 60,
      iat: now,
      iss: issuerId,
    }),
  ].join('.');
  const signature = sign('sha256', Buffer.from(signingInput), {
    dsaEncoding: 'ieee-p1363',
    key: privateKey,
  }).toString('base64url');

  return `${signingInput}.${signature}`;
}

function createUrl(path, params = {}) {
  const url = new URL(path, ASC_API_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

async function appStoreConnectFetch(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `App Store Connect request failed: ${response.status} ${response.statusText}\n${url}\n${body}`
    );
  }

  return response.json();
}

async function collectPaginated(url, token) {
  const items = [];
  let nextUrl = url;
  while (nextUrl) {
    const response = await appStoreConnectFetch(nextUrl, token);
    if (Array.isArray(response.data)) {
      items.push(...response.data);
    }
    nextUrl = response.links?.next ? new URL(response.links.next) : null;
  }
  return items;
}

function getBuildVersion(build) {
  const value = build?.attributes?.version;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(
      `Unsupported existing iOS build number: ${value ?? '<missing>'}. ` +
        'This CI resolver expects integer build numbers.'
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Existing iOS build number is not a safe integer: ${value}`);
  }
  return parsed;
}

async function resolveNextBuildNumber() {
  const token = createAppStoreConnectJwt();
  const bundleId = requiredEnv('IOS_BUNDLE_ID');
  const marketingVersion = requiredEnv('MOBILE_VERSION_NAME');

  const apps = await appStoreConnectFetch(
    createUrl('/v1/apps', {
      'filter[bundleId]': bundleId,
      limit: '1',
    }),
    token
  );
  const app = apps.data?.[0];
  if (!app?.id) {
    throw new Error(`No App Store Connect app found for bundle id: ${bundleId}`);
  }

  const prereleaseVersions = await appStoreConnectFetch(
    createUrl('/v1/preReleaseVersions', {
      'filter[app]': app.id,
      'filter[platform]': IOS_PLATFORM,
      'filter[version]': marketingVersion,
      limit: '1',
    }),
    token
  );
  const prereleaseVersion = prereleaseVersions.data?.[0];
  if (!prereleaseVersion?.id) {
    console.error(
      `No existing iOS prerelease version ${marketingVersion} found for ${bundleId}; using build 1.`
    );
    return 1;
  }

  const builds = await collectPaginated(
    createUrl(`/v1/preReleaseVersions/${prereleaseVersion.id}/builds`, {
      limit: '200',
    }),
    token
  );
  const buildNumbers = builds.map(getBuildVersion);
  if (buildNumbers.length === 0) {
    console.error(
      `No integer iOS builds found for ${bundleId} ${marketingVersion}; using build 1.`
    );
    return 1;
  }

  return Math.max(...buildNumbers) + 1;
}

try {
  const nextBuildNumber = await resolveNextBuildNumber();
  process.stdout.write(`${nextBuildNumber}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
