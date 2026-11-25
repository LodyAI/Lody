#!/usr/bin/env node
import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const EXPECTED_APP_ID = 'YTRMX32C99.ai.lody.desktop'
const EXPECTED_TEAM_ID = 'YTRMX32C99'
const EXPECTED_ASSOCIATED_DOMAIN = 'webcredentials:lody.ai'

function extractTagAfterKey(xml, keyName, tagName) {
  const escapedKey = keyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `<key>\\s*${escapedKey}\\s*</key>\\s*<${tagName}>([\\s\\S]*?)</${tagName}>`
  )
  const match = xml.match(pattern)
  return match ? match[1] : undefined
}

function extractEntitlementsDict(xml) {
  const dictBody = extractTagAfterKey(xml, 'Entitlements', 'dict')
  if (dictBody === undefined) {
    throw new Error('macOS Passkey provisioning profile is missing Entitlements dictionary')
  }
  return dictBody
}

function parseAssociatedDomains(entitlementsXml) {
  const arrayBody = extractTagAfterKey(
    entitlementsXml,
    'com.apple.developer.associated-domains',
    'array'
  )
  if (arrayBody !== undefined) {
    return [...arrayBody.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => m[1].trim())
  }
  const single = extractTagAfterKey(
    entitlementsXml,
    'com.apple.developer.associated-domains',
    'string'
  )
  if (single !== undefined) {
    return [single.trim()]
  }
  return []
}

function allowsAssociatedDomain(entries, requiredDomain) {
  return entries.some((entry) => entry === '*' || entry === requiredDomain)
}

export function parseProvisioningProfilePlist(xml) {
  const entitlementsXml = extractEntitlementsDict(xml)
  const appId = extractTagAfterKey(
    entitlementsXml,
    'com.apple.application-identifier',
    'string'
  )?.trim()
  const teamId = extractTagAfterKey(
    entitlementsXml,
    'com.apple.developer.team-identifier',
    'string'
  )?.trim()
  const associatedDomains = parseAssociatedDomains(entitlementsXml)
  const expirationRaw = extractTagAfterKey(xml, 'ExpirationDate', 'date')?.trim()
  const expirationDate = expirationRaw ? new Date(expirationRaw) : undefined

  const certsArrayBody = extractTagAfterKey(xml, 'DeveloperCertificates', 'array')
  const developerCertificates = certsArrayBody
    ? [...certsArrayBody.matchAll(/<data>([\s\S]*?)<\/data>/g)].map((match) => {
        const der = Buffer.from(match[1].replace(/\s+/g, ''), 'base64')
        return new X509Certificate(der)
      })
    : []

  return {
    appId,
    teamId,
    associatedDomains,
    expirationDate,
    developerCertificates
  }
}

export function parsePemCertificates(pemText) {
  const blocks = pemText.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)
  if (!blocks?.length) {
    throw new Error('No X.509 certificate found in PEM input')
  }
  return blocks.map((block) => new X509Certificate(block))
}

function formatCertSummary(cert) {
  return `${cert.fingerprint256} (serial=${cert.serialNumber}, subject=${cert.subject.replace(/\n/g, ', ')}, validTo=${cert.validTo})`
}

export function verifyProvisioningProfileAgainstCertificates({
  plistXml,
  signingCertificates,
  now = new Date(),
  expectedAppId = EXPECTED_APP_ID,
  expectedTeamId = EXPECTED_TEAM_ID,
  expectedAssociatedDomain = EXPECTED_ASSOCIATED_DOMAIN
}) {
  if (!signingCertificates?.length) {
    throw new Error('At least one signing certificate is required for profile verification')
  }

  const profile = parseProvisioningProfilePlist(plistXml)

  if (!allowsAssociatedDomain(profile.associatedDomains, expectedAssociatedDomain)) {
    throw new Error(
      `macOS Passkey provisioning profile is missing associated-domains entitlement covering ${expectedAssociatedDomain} (got ${JSON.stringify(profile.associatedDomains)})`
    )
  }

  if (profile.appId !== expectedAppId) {
    throw new Error(
      `macOS Passkey provisioning profile application-identifier mismatch (expected ${expectedAppId}, got ${profile.appId || 'empty'})`
    )
  }

  if (profile.teamId !== expectedTeamId) {
    throw new Error(
      `macOS Passkey provisioning profile team-identifier mismatch (expected ${expectedTeamId}, got ${profile.teamId || 'empty'})`
    )
  }

  if (!profile.expirationDate || Number.isNaN(profile.expirationDate.getTime())) {
    throw new Error('macOS Passkey provisioning profile is missing a valid ExpirationDate')
  }

  if (profile.expirationDate.getTime() <= now.getTime()) {
    throw new Error(
      `macOS Passkey provisioning profile expired at ${profile.expirationDate.toISOString()}`
    )
  }

  if (profile.developerCertificates.length === 0) {
    throw new Error('macOS Passkey provisioning profile contains no DeveloperCertificates')
  }

  const profileFingerprints = new Set(
    profile.developerCertificates.map((cert) => cert.fingerprint256)
  )
  const matched = signingCertificates.find((cert) => profileFingerprints.has(cert.fingerprint256))

  if (!matched) {
    const signingList = signingCertificates.map(formatCertSummary).join('; ')
    const profileList = profile.developerCertificates.map(formatCertSummary).join('; ')
    throw new Error(
      `macOS Passkey provisioning profile does not authorize the signing certificate.\n` +
        `  Signing certificate(s): ${signingList}\n` +
        `  Profile DeveloperCertificates: ${profileList}`
    )
  }

  return {
    matchedFingerprint256: matched.fingerprint256,
    matchedSerialNumber: matched.serialNumber,
    expirationDate: profile.expirationDate
  }
}

function parseCliArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (
      token === '--plist' ||
      token === '--cert-pem' ||
      token === '--cert-der' ||
      token === '--app-id'
    ) {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${token}`)
      }
      args[token.slice(2)] = value
      i += 1
    } else {
      throw new Error(`Unknown argument: ${token}`)
    }
  }
  return args
}

function runCli(argv) {
  const args = parseCliArgs(argv)
  if (!args.plist) {
    throw new Error('Missing required --plist <path>')
  }
  if (!args['cert-pem'] && !args['cert-der']) {
    throw new Error('Provide either --cert-pem <path> or --cert-der <path>')
  }

  const plistXml = readFileSync(args.plist, 'utf8')
  const signingCertificates = args['cert-pem']
    ? parsePemCertificates(readFileSync(args['cert-pem'], 'utf8'))
    : [new X509Certificate(readFileSync(args['cert-der']))]

  const result = verifyProvisioningProfileAgainstCertificates({
    plistXml,
    signingCertificates,
    expectedAppId: args['app-id'] || EXPECTED_APP_ID
  })
  console.log(
    `Verified macOS Passkey provisioning profile matches signing certificate ${result.matchedFingerprint256} (serial=${result.matchedSerialNumber}, expires=${result.expirationDate.toISOString()})`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
