/**
 * GPG-sign the Linux release artifacts and their checksum manifest.
 *
 * The night feed carries an artifact inventory consumed by electron-updater; a detached signature
 * lets users verify what they downloaded. The private key lives only in the release environment
 * (a GitHub Actions secret), so this script expects an unlocked secret key in `GNUPGHOME`.
 *
 * Usage: tsx scripts/sign-linux-artifacts.mjs [artifacts-directory]
 * Requires: gpg on PATH, `LINUX_GPG_KEY_ID` or exactly one secret key in GNUPGHOME.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { desktopArtifactOutput, desktopTargetBuildPaths } from './desktop-build-paths.mjs'

/** Artifact kinds that receive a detached signature. */
const SIGNED_FILE = /\.(?:AppImage|deb|ya?ml)$/u

/** Order signatures after their artifacts and feed, independent of directory order. */
const SIGNATURE_SUFFIX = '.asc'

function gpg(args) {
  return execFileSync('gpg', ['--batch', '--no-tty', '--yes', ...args], { encoding: 'utf8' })
}

/** Secret key this release signs with. */
function resolveKeyId() {
  const configured = process.env.LINUX_GPG_KEY_ID?.trim()
  if (configured !== undefined && configured !== '') return configured
  const colon = gpg(['--list-secret-keys', '--with-colons']).split('\n')
  const fingerprints = colon.filter(line => line.startsWith('fpr:')).map(line => line.split(':')[9])
  if (fingerprints.length !== 1) {
    throw new Error(`sign-linux-artifacts: expected one secret key or LINUX_GPG_KEY_ID, found ${fingerprints.length}`)
  }
  return fingerprints[0]
}

function signFile(path, keyId) {
  gpg(['--armor', '--detach-sign', '--local-user', keyId, '--output', `${path}${SIGNATURE_SUFFIX}`, path])
  gpg(['--verify', `${path}${SIGNATURE_SUFFIX}`, path])
}

/** Write SHA-256 lines ordered by file name, then sign the manifest itself. */
function writeChecksums(directory, files, keyId) {
  const lines = files.map(name => {
    const digest = createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')
    return `${digest}  ${name}`
  })
  const manifest = join(directory, 'SHA256SUMS')
  writeFileSync(manifest, `${lines.join('\n')}\n`)
  signFile(manifest, keyId)
}

const keyId = resolveKeyId()
const directory = resolve(process.argv[2] ?? desktopArtifactOutput(
  desktopTargetBuildPaths('linux-x64'), { unsigned: true, skipNotarization: false }).directory)
const signed = readdirSync(directory).filter(name => SIGNED_FILE.test(name)
  && !name.endsWith(SIGNATURE_SUFFIX) && name !== 'builder-debug.yml').sort()
if (signed.length === 0) throw new Error(`sign-linux-artifacts: no artifacts to sign in ${directory}`)

for (const name of signed) signFile(join(directory, name), keyId)
writeChecksums(directory, signed, keyId)
process.stdout.write(`signed ${signed.length} artifact(s) with ${keyId} in ${directory}\n`)
