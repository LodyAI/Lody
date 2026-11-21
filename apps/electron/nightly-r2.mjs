import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { NIGHTLY_JOURNAL_KEY, NIGHTLY_METADATA_KEYS } from './nightly-publication.mjs'
import { NIGHTLY_VERSION_KEY } from './nightly-version.mjs'

const execute = promisify(execFile)

export const NIGHTLY_ANDROID_METADATA_KEY = 'android-version.json'

export async function hashFile(filename, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest(encoding)
}

export function safeNightlyKey(key) {
  if ([NIGHTLY_JOURNAL_KEY, NIGHTLY_VERSION_KEY].includes(key)) return key
  if (
    typeof key !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._+ -]*(?:\/[A-Za-z0-9][A-Za-z0-9._+ -]*)?$/u.test(key)
  ) {
    throw new Error('Unsafe Nightly object key')
  }
  return key
}

/** AWS CLI is supplied by the runner; credentials remain in the consuming step's environment. */
export function createNightlyR2Store(env = process.env) {
  const bucket = env.R2_NIGHTLY_BUCKET
  const prefix = env.R2_NIGHTLY_PREFIX
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(bucket ?? '')) {
    throw new Error('A valid Nightly R2 bucket is required')
  }
  if (
    !/^[a-f0-9]{32}$/u.test(env.R2_ACCOUNT_ID ?? '') ||
    !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(prefix ?? '') ||
    !prefix.split('/').includes('nightly')
  ) {
    throw new Error('Invalid Nightly R2 account or prefix')
  }
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY)
    throw new Error('Nightly R2 credentials are required')
  const downloadUrl = new URL(env.VITE_ELECTRON_UPDATE_URL)
  if (
    downloadUrl.protocol !== 'https:' ||
    downloadUrl.username ||
    downloadUrl.password ||
    downloadUrl.search ||
    downloadUrl.hash ||
    downloadUrl.pathname.replace(/\/$/u, '') !== `/${prefix}`
  ) {
    throw new Error('Nightly download URL path must match the R2 prefix')
  }
  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  const keyOf = (key) => `${prefix}/${safeNightlyKey(key)}`
  const aws = async (operation, key, args = [], allowMissing = false) => {
    try {
      const result = await execute(
        'aws',
        [
          's3api',
          operation,
          '--bucket',
          bucket,
          '--key',
          keyOf(key),
          '--endpoint-url',
          endpoint,
          '--region',
          'auto',
          '--no-cli-pager',
          ...args
        ],
        {
          env: {
            ...env,
            AWS_MAX_ATTEMPTS: '3',
            AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
            AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required'
          },
          maxBuffer: 1024 * 1024
        }
      )
      return result.stdout.trim() ? JSON.parse(result.stdout) : {}
    } catch (error) {
      if (allowMissing && /\((?:NoSuchKey|404)\)/u.test(error.stderr ?? '')) return null
      // eslint-disable-next-line preserve-caught-error -- Remote diagnostics must not enter release logs.
      throw new Error(`R2 ${operation} failed for ${key}`)
    }
  }
  const temporary = async (fn) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'lody-nightly-r2-'))
    try {
      return await fn(path.join(directory, 'object'))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
  const metadataKey = (key) => {
    if (
      ![
        ...NIGHTLY_METADATA_KEYS,
        NIGHTLY_JOURNAL_KEY,
        NIGHTLY_VERSION_KEY,
        NIGHTLY_ANDROID_METADATA_KEY
      ].includes(key)
    )
      throw new Error('Unknown Nightly metadata key')
  }
  return {
    async get(key) {
      metadataKey(key)
      const head = await aws('head-object', key, [], true)
      if (head === null) return null
      const limit = key === NIGHTLY_JOURNAL_KEY ? 90 * 1024 * 1024 : 5 * 1024 * 1024
      if (
        !Number.isSafeInteger(head.ContentLength) ||
        head.ContentLength <= 0 ||
        head.ContentLength > limit
      ) {
        throw new Error(`Excessive Nightly metadata: ${key}`)
      }
      return temporary(async (filename) => {
        await aws('get-object', key, [filename])
        if ((await stat(filename)).size > limit) throw new Error('Metadata grew beyond limit')
        return readFile(filename)
      })
    },
    async put(key, bytes) {
      metadataKey(key)
      await temporary(async (filename) => {
        await writeFile(filename, bytes)
        await aws('put-object', key, [
          '--body',
          filename,
          '--cache-control',
          'no-cache',
          '--content-type',
          key.endsWith('.json')
            ? 'application/json'
            : key.endsWith('.xml')
              ? 'application/xml'
              : 'text/yaml'
        ])
      })
    },
    async remove(key) {
      metadataKey(key)
      if (key === NIGHTLY_VERSION_KEY) throw new Error('Cannot delete Nightly version reservations')
      await aws('delete-object', key)
    },
    async ensureImmutable(key, filename, sha256) {
      safeNightlyKey(key)
      if (
        !/\.(?:dmg|zip|exe|AppImage|deb|snap|delta|blockmap|apk)$/u.test(key) ||
        !/^[a-f0-9]{64}$/u.test(sha256)
      )
        throw new Error('Invalid immutable Nightly asset')
      if ((await hashFile(filename)) !== sha256) throw new Error(`Local asset changed: ${key}`)
      const head = await aws('head-object', key, [], true)
      if (head === null) {
        await aws('put-object', key, [
          '--body',
          filename,
          '--if-none-match',
          '*',
          '--cache-control',
          'public, max-age=31536000, immutable',
          '--content-type',
          key.endsWith('.apk')
            ? 'application/vnd.android.package-archive'
            : 'application/octet-stream'
        ])
      } else if (head.ContentLength !== (await stat(filename)).size) {
        throw new Error(`Immutable R2 object has a different size: ${key}`)
      }
      await temporary(async (download) => {
        await aws('get-object', key, [download])
        if ((await hashFile(download)) !== sha256)
          throw new Error(`Immutable R2 object differs: ${key}`)
      })
    }
  }
}
