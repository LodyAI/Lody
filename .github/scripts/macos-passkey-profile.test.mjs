import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  parsePemCertificates,
  verifyProvisioningProfileAgainstCertificates
} from './macos-passkey-profile.mjs'

const scriptPath = fileURLToPath(new URL('./macos-passkey-profile.mjs', import.meta.url))

function generateSelfSignedCert(dir, name, cn) {
  const keyPath = path.join(dir, `${name}.key`)
  const pemPath = path.join(dir, `${name}.pem`)
  const derPath = path.join(dir, `${name}.der`)
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      pemPath,
      '-days',
      '30',
      '-nodes',
      '-subj',
      `/CN=${cn}`
    ],
    { stdio: 'pipe' }
  )
  execFileSync('openssl', ['x509', '-in', pemPath, '-outform', 'DER', '-out', derPath], {
    stdio: 'pipe'
  })
  const pem = readFileSync(pemPath, 'utf8')
  const der = readFileSync(derPath)
  return {
    pemPath,
    derPath,
    pem,
    der,
    cert: new X509Certificate(der)
  }
}

function buildProfilePlist({
  certsDer,
  appId = 'YTRMX32C99.ai.lody.desktop',
  teamId = 'YTRMX32C99',
  associatedDomainsXml = '<string>*</string>',
  expirationDate = '2030-01-01T00:00:00Z'
}) {
  const certsXml = certsDer
    .map((der) => `    <data>\n${der.toString('base64')}\n    </data>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>DeveloperCertificates</key>
  <array>
${certsXml}
  </array>
  <key>Entitlements</key>
  <dict>
    <key>com.apple.application-identifier</key>
    <string>${appId}</string>
    <key>com.apple.developer.associated-domains</key>
    ${associatedDomainsXml}
    <key>com.apple.developer.team-identifier</key>
    <string>${teamId}</string>
  </dict>
  <key>ExpirationDate</key>
  <date>${expirationDate}</date>
</dict>
</plist>
`
}

test('rejects a provisioning profile bound to a different Developer ID certificate than the app signing cert', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lody-passkey-profile-test-'))
  try {
    const profileCert = generateSelfSignedCert(dir, 'profile-cert', 'Developer ID A')
    const signingCert = generateSelfSignedCert(dir, 'signing-cert', 'Developer ID B')
    const now = new Date('2026-11-25T00:00:00Z')

    const matchingPlist = buildProfilePlist({ certsDer: [profileCert.der] })
    const ok = verifyProvisioningProfileAgainstCertificates({
      plistXml: matchingPlist,
      signingCertificates: [profileCert.cert],
      now
    })
    assert.equal(ok.matchedFingerprint256, profileCert.cert.fingerprint256)

    assert.throws(
      () =>
        verifyProvisioningProfileAgainstCertificates({
          plistXml: matchingPlist,
          signingCertificates: [signingCert.cert],
          now
        }),
      (error) => {
        assert.match(error.message, /does not authorize the signing certificate/)
        assert.ok(error.message.includes(signingCert.cert.fingerprint256))
        assert.ok(error.message.includes(profileCert.cert.fingerprint256))
        return true
      }
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('enforces expiry, entitlements, and CLI verification for both PEM and DER certificates', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lody-passkey-profile-cli-'))
  try {
    const cert = generateSelfSignedCert(dir, 'cert', 'Developer ID Match')
    const now = new Date('2026-11-25T00:00:00Z')

    assert.throws(
      () =>
        verifyProvisioningProfileAgainstCertificates({
          plistXml: buildProfilePlist({
            certsDer: [cert.der],
            expirationDate: '2026-11-24T23:59:59Z'
          }),
          signingCertificates: [cert.cert],
          now
        }),
      /expired/
    )

    assert.throws(
      () =>
        verifyProvisioningProfileAgainstCertificates({
          plistXml: buildProfilePlist({
            certsDer: [cert.der],
            associatedDomainsXml: '<array><string>webcredentials:other.example</string></array>'
          }),
          signingCertificates: [cert.cert],
          now
        }),
      /associated-domains/
    )

    const explicitPlist = buildProfilePlist({
      certsDer: [cert.der],
      associatedDomainsXml: '<array><string>webcredentials:lody.ai</string></array>',
      expirationDate: '2035-01-01T00:00:00Z'
    })
    const plistPath = path.join(dir, 'profile.plist')
    writeFileSync(plistPath, explicitPlist, 'utf8')

    assert.equal(parsePemCertificates(cert.pem).length, 1)

    const pemOutput = execFileSync(
      process.execPath,
      [scriptPath, '--plist', plistPath, '--cert-pem', cert.pemPath],
      { encoding: 'utf8' }
    )
    assert.match(pemOutput, new RegExp(cert.cert.fingerprint256))

    const derOutput = execFileSync(
      process.execPath,
      [scriptPath, '--plist', plistPath, '--cert-der', cert.derPath],
      { encoding: 'utf8' }
    )
    assert.match(derOutput, new RegExp(cert.cert.fingerprint256))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
