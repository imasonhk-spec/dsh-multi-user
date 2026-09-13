#!/usr/bin/env node
/**
 * check_profile_sync.mjs — verifies that a user space inherits the host
 * profile's *application set*.
 *
 * Runs a REAL supervisor against a synthetic host home. Kept separate from
 * smoke.mjs because the interesting behaviour is on the filesystem rather than
 * over HTTP: which entries get mirrored, which are deliberately left behind,
 * and whether an unchanged host profile costs any copying at all.
 *
 * Usage: node tools/check_profile_sync.mjs
 * Exit code 0 = all checks passed, 1 = failures, 2 = setup problem.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

// The dev tree keeps the source at src/dsh-multi-user/; the portable package
// ships the same files as payload/dsh-multi-user/. Try both, so this script
// runs wherever it happens to be unpacked.
const CANDIDATES = [
  '../src/dsh-multi-user/lib/supervisor.js',
  '../payload/dsh-multi-user/lib/supervisor.js',
  '../payload/lib/supervisor.js',
]
let moduleUrl = null
for (const relative of CANDIDATES) {
  const candidate = new URL(relative, import.meta.url)
  if (existsSync(candidate)) {
    moduleUrl = candidate
    break
  }
}
if (moduleUrl === null) {
  console.error(`cannot locate lib/supervisor.js; tried:\n  ${CANDIDATES.join('\n  ')}`)
  process.exit(2)
}
const { createSupervisor } = await import(moduleUrl.href)

const SKIP = Symbol('skip')
let passed = 0
let skipped = 0
const failures = []
async function check(label, fn) {
  try {
    if ((await fn()) === SKIP) return
    passed += 1
    process.stdout.write(`  ok   ${label}\n`)
  } catch (error) {
    failures.push(label)
    process.stdout.write(`  FAIL ${label}\n         ${error.message}\n`)
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}
function skip(label, why) {
  skipped += 1
  process.stdout.write(`  skip ${label} · ${why}\n`)
  return SKIP
}

// ── a synthetic host installation ───────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'dshmu-sync-'))
const hostHome = join(root, 'host')
const hostProfile = join(hostHome, 'profiles', 'web')
const HOST_APPS = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-raganything-kb']

mkdirSync(join(hostProfile, 'node_modules', 'dsh-raganything-kb'), { recursive: true })
mkdirSync(join(hostProfile, 'node_modules', 'dsh-multi-user', 'lib'), { recursive: true })
mkdirSync(join(hostProfile, '.dsh-module-fallback', 'nested'), { recursive: true })
writeFileSync(join(hostProfile, 'node_modules', 'dsh-raganything-kb', 'index.js'), 'export const name = "dsh-raganything-kb"\n')
writeFileSync(join(hostProfile, 'node_modules', 'dsh-multi-user', 'lib', 'index.js'), 'export const name = "dsh-multi-user"\n')
writeFileSync(join(hostProfile, 'cordis.patch.yml'), '[]\n')
writeFileSync(join(hostProfile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
writeFileSync(join(hostProfile, 'package.json.bak-dshmu-20260101-000000'), '{}\n')

function writeHostManifest(bundles) {
  writeFileSync(
    join(hostProfile, 'package.json'),
    `${JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { 'dsh-raganything-kb': 'file:/tmp/dsh-raganything-kb.tgz' },
      dsh: { profile: { bundles, patchReload: 'live' } },
    }, null, 2)}\n`,
  )
}
writeHostManifest(HOST_APPS)

const dataDir = join(root, 'data')
const config = {
  logDir: join(dataDir, 'logs'),
  usersDir: join(dataDir, 'users'),
  idleTimeoutMinutes: 0,
  portBase: 31000,
  portScanRange: 5,
  startTimeoutSeconds: 1,
  seedOnCreate: false,
  seedFiles: [],
  dshRoot: root,
  dshBin: 'pnpm',
  dshArgs: [],
  adminHomeMode: 'managed',
  inheritProfile: true,
  profile: 'web',
  syncProfileOnStart: true,
  appSyncIntervalMs: 0,
  minPasswordLength: 8,
}
const quiet = { info() {}, warn() {}, error() {} }
const supervisor = createSupervisor(config, { logger: quiet, hostHome: () => hostHome })
const user = { username: 'probe', homeDir: null, workspaceDir: null }
const userProfile = join(config.usersDir, 'probe', 'home', 'profiles', 'web')

console.log('\nprofile application-set inheritance')

const emptyListCount = (text) => text.split('\n').filter((line) => line.trim() === '[]').length

await check('the first mirror copies the host application set', async () => {
  const result = await supervisor.syncProfile(user)
  assert(result.changed === true, `expected a first-time mirror, got ${JSON.stringify(result)}`)
  assert(result.apps.includes('dsh-raganything-kb'), `app list omits the knowledge base: ${JSON.stringify(result.apps)}`)
  assert(existsSync(join(userProfile, 'package.json')), 'package.json was not mirrored')
  assert(existsSync(join(userProfile, 'node_modules', 'dsh-raganything-kb', 'index.js')), 'node_modules was not mirrored')
  assert(existsSync(join(userProfile, 'pnpm-workspace.yaml')), 'pnpm-workspace.yaml was not mirrored')
})

await check('an account that declares no overrides keeps the stock patch file verbatim', async () => {
  // Regression: the managed-override layer must never touch a patch file it did
  // not write. Appending `[]` to a pristine one leaves TWO empty lists, which
  // YAML reads as two documents — every account on the host then fails to boot.
  const patchFile = join(userProfile, 'cordis.patch.yml')
  const before = readFileSync(patchFile, 'utf8')
  rmSync(join(userProfile, '.dshmu-profile-sync.json'), { force: true })
  await supervisor.syncProfile(user)
  const after = readFileSync(patchFile, 'utf8')
  assert(after === before, `the stock patch file was rewritten:\n--- before ---\n${before}\n--- after ---\n${after}`)
  assert(emptyListCount(after) === 1, `expected exactly one empty list, found ${emptyListCount(after)}`)
})

await check('installer backups and the fallback tree stay out of the user space', async () => {
  assert(!existsSync(join(userProfile, 'package.json.bak-dshmu-20260101-000000')), 'a .bak file was mirrored')
  assert(!existsSync(join(userProfile, '.dsh-module-fallback')), 'the fallback tree was mirrored')
})

await check('an unchanged host profile costs no copying', async () => {
  const result = await supervisor.syncProfile(user)
  assert(result.changed !== true, `expected no change, got ${JSON.stringify(result)}`)
  assert(result.unchanged === true, 'the result should report "unchanged"')
})

await check("a user's own patch layer survives a re-mirror", async () => {
  writeFileSync(join(userProfile, 'cordis.patch.yml'), '- id: mine\n  disabled: true\n')
  rmSync(join(userProfile, '.dshmu-profile-sync.json'), { force: true })
  const result = await supervisor.syncProfile(user)
  assert(result.changed === true, 'removing the marker should force a re-mirror')
  assert(
    readFileSync(join(userProfile, 'cordis.patch.yml'), 'utf8').includes('id: mine'),
    "the user's own cordis.patch.yml was overwritten",
  )
})

await check('a plugin installed on the host appears for the user', async () => {
  mkdirSync(join(hostProfile, 'node_modules', 'dsh-extra-tool'), { recursive: true })
  writeFileSync(join(hostProfile, 'node_modules', 'dsh-extra-tool', 'index.js'), 'export const name = "dsh-extra-tool"\n')
  writeHostManifest([...HOST_APPS, 'dsh-extra-tool'])
  const result = await supervisor.syncProfile(user)
  assert(result.changed === true, `expected a change after installing an app, got ${JSON.stringify(result)}`)
  assert(result.apps.includes('dsh-extra-tool'), `the mirrored app list is stale: ${JSON.stringify(result.apps)}`)
  assert(existsSync(join(userProfile, 'node_modules', 'dsh-extra-tool', 'index.js')), 'the new plugin was not mirrored')
})

await check('a plugin removed from the host disappears for the user', async () => {
  rmSync(join(hostProfile, 'node_modules', 'dsh-extra-tool'), { recursive: true, force: true })
  writeHostManifest(HOST_APPS)
  const result = await supervisor.syncProfile(user)
  assert(result.changed === true, 'expected a change after uninstalling an app')
  assert(!existsSync(join(userProfile, 'node_modules', 'dsh-extra-tool')), 'the removed plugin is still present for the user')
})

await check('hostApps() reports what the host currently advertises', async () => {
  const apps = supervisor.hostApps()
  assert(apps.includes('dsh-raganything-kb'), `hostApps omitted the knowledge base: ${JSON.stringify(apps)}`)
  assert(!apps.includes('dsh-extra-tool'), 'hostApps still lists an uninstalled plugin')
})

await check('inheritance can be switched off', async () => {
  const off = createSupervisor({ ...config, inheritProfile: false }, { logger: quiet, hostHome: () => hostHome })
  const result = await off.syncProfile(user)
  assert(result.synced === false, 'inheritProfile:false should skip the mirror')
  assert(!result.changed, 'a disabled mirror must not report a change')
})

await check('a host without the profile is tolerated, not fatal', async () => {
  const bare = createSupervisor(config, { logger: quiet, hostHome: () => join(root, 'no-such-home') })
  const result = await bare.syncProfile(user)
  assert(result.synced === false, 'a missing host profile should not be treated as a mirror')
})

console.log('\nper-account overrides (the isolation hook)')

const MANAGED = 'dsh-multi-user: managed overrides'
mkdirSync(join(root, 'fake-models'), { recursive: true })
const withPatch = createSupervisor({
  ...config,
  sidecarPortBase: 32000,
  userProfilePatch: [
    '- id: raganything-kb',
    '  config:',
    "    ragHome: '{home}/raganything'",
    '    sidecarPort: {sidecarPort}',
    "    owner: '{username}'",
    '    dshPort: {port}',
  ].join('\n'),
  userSeedLinks: { 'shared/models': join(root, 'fake-models') },
}, { logger: quiet, hostHome: () => hostHome })

// slot 3 + port 31003 stand in for "the fourth account's fixed resources".
const slotted = { username: 'slotted', homeDir: null, workspaceDir: null, slot: 3, port: 31003 }
const slottedHome = join(config.usersDir, 'slotted', 'home')
const slottedPatch = join(slottedHome, 'profiles', 'web', 'cordis.patch.yml')
const slottedMarker = join(slottedHome, 'profiles', 'web', '.dshmu-profile-sync.json')

await check('per-account overrides land in the user profile patch', async () => {
  const result = await withPatch.syncProfile(slotted)
  assert(result.changed === true, 'expected a first mirror')
  const text = readFileSync(slottedPatch, 'utf8')
  assert(text.includes(MANAGED), 'the managed block has no fence')
  assert(text.includes('sidecarPort: 32003'), `the slot was not applied to the port:\n${text}`)
  assert(text.includes(slottedHome), 'the {home} placeholder was not substituted')
  assert(text.includes('raganything'), 'the derived ragHome path is missing')
  assert(text.includes("owner: 'slotted'"), 'the {username} placeholder was not substituted')
  assert(text.includes('dshPort: 31003'), 'the {port} placeholder was not substituted')
})

await check('re-syncing does not duplicate the managed block', async () => {
  rmSync(slottedMarker, { force: true })
  await withPatch.syncProfile(slotted)
  const copies = readFileSync(slottedPatch, 'utf8').split('sidecarPort: 32003').length - 1
  assert(copies === 1, `the managed block was duplicated (${copies} copies)`)
})

await check('a patch the user wrote coexists with the managed block', async () => {
  writeFileSync(slottedPatch, '- id: mine\n  disabled: true\n')
  rmSync(slottedMarker, { force: true })
  await withPatch.syncProfile(slotted)
  const text = readFileSync(slottedPatch, 'utf8')
  assert(text.includes('id: mine'), "the user's own entry was lost")
  assert(text.includes('sidecarPort: 32003'), 'the managed block was lost')
})

await check('a stock "[]" patch is replaced, not appended to', async () => {
  writeFileSync(slottedPatch, '# leading comment\n[]\n')
  rmSync(slottedMarker, { force: true })
  await withPatch.syncProfile(slotted)
  const text = readFileSync(slottedPatch, 'utf8')
  assert(text.includes('sidecarPort: 32003'), 'the managed block is missing')
  assert(!/^\[\]$/m.test(text), 'the empty list survived, which makes the file invalid YAML')
})

await check('declared read-only bulk is linked, not copied', async () => {
  const probe = join(root, 'symlink-probe')
  let canLink = true
  try {
    symlinkSync(join(root, 'fake-models'), probe)
  } catch {
    canLink = false
  }
  rmSync(probe, { force: true, recursive: true })
  if (!canLink) return skip('declared read-only bulk is linked, not copied', 'symlinks need privileges here')

  const link = join(slottedHome, 'shared', 'models')
  assert(existsSync(link), 'the declared symlink was not created')
  assert(lstatSync(link).isSymbolicLink(), 'the declared path is a real directory, not a symlink')
})

await check('a settled mirror reports no change, so instances never restart in a loop', async () => {
  await withPatch.syncProfile(slotted)
  const second = await withPatch.syncProfile(slotted)
  assert(
    second.unchanged === true,
    `an already-current mirror must not keep reporting a change: ${JSON.stringify(second)}`,
  )
})

await check('a change to the per-account overrides reaches an already-synced account', async () => {
  const retuned = createSupervisor({
    ...config,
    sidecarPortBase: 33000,
    userProfilePatch: '- id: raganything-kb\n  config:\n    sidecarPort: {sidecarPort}\n',
  }, { logger: quiet, hostHome: () => hostHome })
  const result = await retuned.syncProfile(slotted)
  assert(
    result.changed === true,
    'the host is unchanged, but the administrator edited the overrides — that alone must invalidate the mirror',
  )
  const text = readFileSync(slottedPatch, 'utf8')
  assert(text.includes('sidecarPort: 33003'), `the new override did not land:\n${text}`)
  assert(!text.includes('sidecarPort: 32003'), 'the previous override survived the edit')
  assert(!text.includes('owner:'), 'an override removed from the config survived the edit')
})

await check('clearing the overrides hands the patch file back', async () => {
  // Put the file in the realistic "user entries + managed block" shape first.
  writeFileSync(slottedPatch, '- id: mine\n  disabled: true\n')
  await withPatch.syncProfile(slotted)
  assert(readFileSync(slottedPatch, 'utf8').includes(MANAGED), 'setup: the managed block should be back')

  const plain = createSupervisor({ ...config }, { logger: quiet, hostHome: () => hostHome })
  const result = await plain.syncProfile(slotted)
  assert(result.changed === true, 'clearing the overrides must invalidate the marker')
  const text = readFileSync(slottedPatch, 'utf8')
  assert(!text.includes(MANAGED), 'the managed block is still pinned to the account')
  assert(text.includes('id: mine'), "the user's own entry was dropped along with the block")
})

await check('a patch left with two empty lists is normalised to one on the next sync', async () => {
  // Reproduces the production incident: an earlier build wrote the profile patch
  // file with two top-level `[]` lines (YAML reads that as two documents), so
  // every account's instance failed to boot. A later sync must repair the file
  // even though the marker still claims "unchanged".
  const plain2 = createSupervisor({ ...config }, { logger: quiet, hostHome: () => hostHome })
  await plain2.syncProfile(slotted) // settle: single `[]`, marker written
  writeFileSync(slottedPatch, '# a comment\n[]\n[]\n') // brick it, leave the marker intact
  const result = await plain2.syncProfile(slotted)
  assert(result.changed === true, `the bricked file was not repaired: ${JSON.stringify(result)}`)
  const healed = readFileSync(slottedPatch, 'utf8')
  const lists = healed.split('\n').filter((line) => line.trim() === '[]').length
  assert(lists === 1, `expected exactly one empty list after healing, found ${lists}:\n${healed}`)
})

rmSync(root, { recursive: true, force: true })

console.log(
  `\n${passed} checks passed`
  + `${skipped === 0 ? '' : `, ${skipped} skipped`}`
  + `${failures.length === 0 ? '' : ` — with ${failures.length} failure(s)`}\n`,
)
process.exit(failures.length === 0 ? 0 : 1)
