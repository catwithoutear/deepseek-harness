/** Archive a signed Linux build, update the rolling feed, then retain six version archives. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { load } from 'js-yaml'

const archiveOnly = process.argv[3] === '--archive-only'
const { GH_REPO: repository, BUILD_VERSION: version, BUILD_COMMIT: commit, RELEASE_NOTES: notes,
  BUILD_FINGERPRINT: fingerprint, RELEASE_TAG: configuredRollingTag } = process.env
const rollingTag = configuredRollingTag || 'linux-nightly'
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.\d{8}\.\d+$/u
if (!process.argv[2] || process.argv.length > 4 || (process.argv[3] && !archiveOnly)
  || !/^[\w.-]+\/[\w.-]+$/u.test(repository ?? '') || !versionPattern.test(version ?? '')
  || !/^[0-9a-f]{40}$/u.test(commit ?? '') || !/^[\w.-]+$/u.test(rollingTag) || !notes) {
  throw new Error('publish-linux-release: require artifact directory, optional --archive-only, GH_REPO, BUILD_VERSION, BUILD_COMMIT, BUILD_FINGERPRINT and RELEASE_NOTES')
}
const directory = resolve(process.argv[2])
const archiveTag = `linux-v${version}`
const binaries = [
  `deepseek-harness-${version}-linux-amd64-unsigned.deb`,
  `deepseek-harness-${version}-linux-x86_64-unsigned.AppImage`,
]
const files = [...binaries, ...binaries.map(name => `${name}.asc`), 'linux-signing-key.asc',
  'nightly-linux.yml', 'nightly-linux.yml.asc', 'SHA256SUMS', 'SHA256SUMS.asc', 'build-fingerprint.txt']
const inventory = new Map(files.map(name => {
  const bytes = readFileSync(join(directory, name))
  if (!bytes.length) throw new Error(`publish-linux-release: empty artifact ${name}`)
  return [name, {
    size: bytes.length,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    sha512: createHash('sha512').update(bytes).digest('base64'),
  }]
}))
const feed = load(readFileSync(join(directory, 'nightly-linux.yml'), 'utf8'))
if (!feed || typeof feed !== 'object' || feed.version !== version || !Array.isArray(feed.files)
  || feed.files.length !== binaries.length) {
  throw new Error('publish-linux-release: feed does not describe this build')
}
for (const name of binaries) {
  const entry = feed.files.find(file => file.url === name)
  if (!entry || entry.size !== inventory.get(name).size || entry.sha512 !== inventory.get(name).sha512) {
    throw new Error(`publish-linux-release: feed hash or size does not match ${name}`)
  }
}
if (!binaries.includes(feed.path) || feed.sha512 !== inventory.get(feed.path).sha512) {
  throw new Error('publish-linux-release: legacy feed path/hash does not match this build')
}
if (!/^[0-9a-f]{40} [0-9a-f]{40}$/u.test(fingerprint ?? '')
  || readFileSync(join(directory, 'build-fingerprint.txt'), 'utf8').trim() !== fingerprint) {
  throw new Error('publish-linux-release: build fingerprint does not match prepare output')
}
const checksums = readFileSync(join(directory, 'SHA256SUMS'), 'utf8').trim().split('\n')
for (const name of [...binaries, 'nightly-linux.yml']) {
  if (!checksums.includes(`${inventory.get(name).digest.slice(7)}  ${name}`)) {
    throw new Error(`publish-linux-release: checksum manifest does not match ${name}`)
  }
}

/** Extract the trailing CI run number from a build version or archive tag. */
const runNumber = value => Number(value.split('.').at(-1))

/** Execute GitHub CLI without shell interpolation; failures stop promotion and cleanup. */
function gh(...args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
}
/** Fetch all release pages, including drafts, without hiding API or authentication failures. */
function releases() {
  return JSON.parse(gh('api', '--paginate', '--slurp', '-H', 'Cache-Control: no-cache', `repos/${repository}/releases?per_page=100`)).flat()
}
/** Reconcile an acknowledged creation without issuing another create on a stale list response. */
async function createdRelease(tag) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const release = releases().find(item => item.tag_name === tag)
    if (release) return release
    await setTimeout(1000)
  }
  throw new Error(`publish-linux-release: ${tag} creation acknowledged but not visible; reconcile it before retrying`)
}
/** Read the complete asset inventory through its independently paginated API. */
function assets(release) {
  return JSON.parse(gh('api', '--paginate', '--slurp', '-H', 'Cache-Control: no-cache', `repos/${repository}/releases/${release.id}/assets?per_page=100`)).flat()
}
/** Verify one remote asset, optionally stored under a staging name, against the local bytes. */
function verifyAsset(actual, name) {
  const expected = inventory.get(name)
  if (!actual || actual.state !== 'uploaded' || actual.size !== expected.size || actual.digest !== expected.digest) {
    throw new Error(`publish-linux-release: upload verification failed for ${actual?.name ?? name}`)
  }
}
/** Verify GitHub's uploaded sizes and digests against the signed local build bytes. */
function verify(release, names = files) {
  const remote = new Map(assets(release).map(asset => [asset.name, asset]))
  for (const name of names) verifyAsset(remote.get(name), name)
}
/** Upload only absent immutable files; existing version bytes are never replaced. */
function upload(tag, names) {
  if (names.length) gh('release', 'upload', tag, ...names.map(name => join(directory, name)), '--repo', repository)
}
/** Rename one release asset by ID so old bytes remain remotely until replaced. */
function renameAsset(id, name) {
  gh('api', '--method', 'PATCH', `repos/${repository}/releases/assets/${id}`, '-f', `name=${name}`)
}
/** Filter and sort published version archives belonging solely to this fork's namespace. */
function versionArchives(entries) {
  return entries
    .filter(release => !release.draft && release.tag_name.startsWith('linux-v')
      && versionPattern.test(release.tag_name.slice('linux-v'.length)))
    .sort((a, b) => runNumber(b.tag_name) - runNumber(a.tag_name))
}
/** Upload and verify mutable channel metadata under version-scoped staging names. */
function stageMetadata(rolling, stageDirectory) {
  const metadata = ['linux-signing-key.asc', 'SHA256SUMS', 'SHA256SUMS.asc', 'nightly-linux.yml.asc',
    'nightly-linux.yml', 'build-fingerprint.txt']
  const moves = []
  for (const name of metadata) {
    const stagedName = `staged-${version}-${name}`
    const backupName = `previous-${version}-${name}`
    const byName = new Map(assets(rolling).map(asset => [asset.name, asset]))
    if (byName.has(backupName)) {
      throw new Error(`publish-linux-release: reconcile retained backup ${backupName} before retrying`)
    }
    let staged = byName.get(stagedName)
    if (!staged) {
      copyFileSync(join(directory, name), join(stageDirectory, stagedName))
      gh('release', 'upload', rollingTag, join(stageDirectory, stagedName), '--repo', repository)
      staged = assets(rolling).find(asset => asset.name === stagedName)
    }
    verifyAsset(staged, name)
    moves.push({ name, staged, old: byName.get(name), stagedName, backupName })
  }
  return moves
}
/** Restore previously live metadata assets by ID if switching the rolling channel fails. */
function restoreMoves(rolling, moves) {
  for (const move of moves.toReversed()) {
    const byId = new Map(assets(rolling).map(asset => [asset.id, asset]))
    if (byId.get(move.staged.id)?.name === move.name) renameAsset(move.staged.id, move.stagedName)
    if (move.old && byId.get(move.old.id)?.name === move.backupName) renameAsset(move.old.id, move.name)
  }
  gh('release', 'edit', rollingTag, '--repo', repository, '--title', rolling.name,
    '--notes', rolling.body ?? '', ...(rolling.draft ? ['--draft'] : []))
}
/** Promote staged metadata, retire archives beyond six, then commit the skip-marker fingerprint. */
function commitMetadata(rolling, moves, archives) {
  for (const move of moves) {
    // Fingerprint is the skip token. Commit it only after promotion and retention succeed.
    if (move.name === 'build-fingerprint.txt') continue
    if (move.old) renameAsset(move.old.id, move.backupName)
    renameAsset(move.staged.id, move.name)
  }
  verify(rolling, files.filter(name => name !== 'build-fingerprint.txt'))
  gh('release', 'edit', rollingTag, '--repo', repository, '--draft=false', '--prerelease', '--latest=false',
    '--title', `Linux nightly · ${version}`, '--notes-file', notes)
  // Retention only runs after a complete, verified channel promotion. Exact namespace only.
  for (const old of archives.slice(6)) {
    console.log(`Retire archive: ${old.tag_name}`)
    gh('release', 'delete', old.tag_name, '--repo', repository, '--yes', '--cleanup-tag')
  }
  const marker = moves.at(-1)
  if (marker.old) renameAsset(marker.old.id, marker.backupName)
  renameAsset(marker.staged.id, marker.name)
  verify(rolling)
}
/** Best-effort cleanup of superseded backups and old binaries after feed commit. */
function cleanupExtraAssets(rolling) {
  let current
  try {
    current = assets(rolling)
  } catch (error) {
    console.warn(`Skipped extra rolling asset cleanup: ${error.message}`)
    return
  }
  for (const asset of current) {
    if (inventory.has(asset.name)) continue
    try {
      gh('release', 'delete-asset', rollingTag, asset.name, '--repo', repository, '--yes')
    } catch (error) {
      console.warn(`Retained extra rolling asset ${asset.name}: ${error.message}`)
    }
  }
}

const existingReleases = releases()
const existingTags = JSON.parse(gh('api', `repos/${repository}/git/matching-refs/tags/${archiveTag}`))
if (existingTags.some(ref => ref.ref === `refs/tags/${archiveTag}`)
  && gh('api', `repos/${repository}/commits/${archiveTag}`, '--jq', '.sha').trim() !== commit) {
  throw new Error(`publish-linux-release: existing ${archiveTag} targets another build`)
}
if (!archiveOnly && versionArchives(existingReleases).some(release => runNumber(release.tag_name) > runNumber(version))) {
  throw new Error('publish-linux-release: refusing promotion of an older build')
}
let archive = existingReleases.find(release => release.tag_name === archiveTag)
if (!archive) {
  gh('release', 'create', archiveTag, '--repo', repository, '--target', commit, '--draft', '--prerelease',
    '--latest=false', '--title', `Linux build · ${version}`, '--notes-file', notes)
  archive = await createdRelease(archiveTag)
}
// GitHub creates a new release's tag on publication, so a draft must retain its exact target SHA.
if (archive.draft && archive.target_commitish !== commit) {
  throw new Error(`publish-linux-release: draft ${archiveTag} targets another build`)
}
if (archive.draft) {
  const present = assets(archive)
  const presentNames = new Set(present.map(asset => asset.name))
  verify(archive, files.filter(name => presentNames.has(name)))
  if (present.some(asset => !inventory.has(asset.name))) throw new Error('publish-linux-release: unexpected draft assets')
  upload(archiveTag, files.filter(name => !presentNames.has(name)))
  verify(archive)
  gh('release', 'edit', archiveTag, '--repo', repository, '--draft=false', '--prerelease', '--latest=false',
    '--title', `Linux build · ${version}`, '--notes-file', notes)
} else {
  verify(archive)
}
const tagCommit = gh('api', `repos/${repository}/commits/${archiveTag}`, '--jq', '.sha').trim()
if (tagCommit !== commit) throw new Error(`publish-linux-release: ${archiveTag} targets another build`)
console.log(`Archive verified: ${archiveTag} at ${commit}`)

if (!archiveOnly) {
  const archives = versionArchives(releases())
  if (archives[0]?.tag_name !== archiveTag) throw new Error('publish-linux-release: refusing promotion of an older build')
  let rolling = releases().find(release => release.tag_name === rollingTag)
  if (!rolling) {
    gh('release', 'create', rollingTag, '--repo', repository, '--target', commit, '--draft', '--prerelease',
      '--latest=false', '--title', `Linux nightly · ${version}`, '--notes-file', notes)
    rolling = await createdRelease(rollingTag)
  }
  if (rolling.draft && rolling.target_commitish !== commit) {
    throw new Error('publish-linux-release: reconcile the existing rolling draft before promotion')
  }
  const immutable = [...binaries, ...binaries.map(name => `${name}.asc`)]
  const presentNames = new Set(assets(rolling).map(asset => asset.name))
  verify(rolling, immutable.filter(name => presentNames.has(name)))
  upload(rollingTag, immutable.filter(name => !presentNames.has(name)))
  verify(rolling, immutable)

  // Upload all small metadata before any live filename is changed. Rename preserves old bytes
  // remotely, unlike --clobber (which deletes before upload). GitHub has no multi-asset transaction.
  const stageDirectory = mkdtempSync(join(tmpdir(), 'linux-release-stage-'))
  try {
    const moves = stageMetadata(rolling, stageDirectory)
    try {
      commitMetadata(rolling, moves, archives)
    } catch (failure) {
      try {
        restoreMoves(rolling, moves)
      } catch (recoveryFailure) {
        throw new AggregateError([failure, recoveryFailure],
          'Channel update and recovery failed; retain remote previous-* assets for manual recovery')
      }
      throw failure
    }
  } finally {
    rmSync(stageDirectory, { recursive: true, force: true })
  }
  // The new feed is committed. Cleanup failures leave harmless extra files and are reported, not
  // rolled back after old bytes have been removed. A later successful publication can clean them.
  cleanupExtraAssets(rolling)
  console.log('Rolling channel verified; retained the six newest version archives')
}
