#!/usr/bin/env node
/**
 * sync_apps.mjs — bring every account level with the host's application set.
 *
 * Application inheritance is normally lazy: an account's profile is mirrored
 * when that account is next used, so a plugin installed on the host shows up on
 * the user's next page load and nobody has to do anything. This tool is for the
 * operator who does not want to wait for that — after installing a plugin, or
 * after editing `userProfilePatch` / `userSeedLinks`, run this to push the
 * change out to every account immediately.
 *
 * It only writes profile trees and per-account patches. It never starts a user
 * instance, never touches credentials, and never deletes an account's data.
 *
 * Usage:
 *   node tools/sync_apps.mjs                      # every account
 *   node tools/sync_apps.mjs --username mason     # just one
 *   node tools/sync_apps.mjs --dsh-home /home/x/.dsh --profile web
 *
 * The plugin's own knobs come from the environment, exactly as the running
 * plugin reads them (`DSH_MU_USER_PROFILE_PATCH`, `DSH_MU_USER_SEED_LINKS`, …),
 * so a deployment that configures overrides in its cordis patch can repeat them
 * here — or simply pass the same values inline:
 *
 *   DSH_MU_USER_PROFILE_PATCH="$PATCH" node tools/sync_apps.mjs
 *
 * Exit code 0 = every account is level, 1 = at least one failed, 2 = setup.
 */

import { existsSync } from 'node:fs'
import process from 'node:process'

const CANDIDATES = [
  '../src/dsh-multi-user/lib/index.js',
  '../payload/dsh-multi-user/lib/index.js',
  '../payload/lib/index.js',
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
  console.error(`cannot locate lib/index.js; tried:\n  ${CANDIDATES.join('\n  ')}`)
  process.exit(2)
}
const { createStore, createSupervisor, hostDshHome, resolveConfig } = await import(moduleUrl.href)

/** Read `--name value` (and bare `--flag`) from argv. */
function argValue(name) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const next = process.argv[index + 1]
  return next === undefined || next.startsWith('--') ? '' : next
}
const flag = (name) => process.argv.includes(`--${name}`)

const dshHome = argValue('dsh-home') ?? process.env.DSH_HOME ?? ''
const profile = argValue('profile') ?? process.env.DSH_PROFILE ?? 'web'
const only = argValue('username')
const verbose = flag('verbose')

const quiet = { info() {}, warn(...args) { console.warn(...args) }, error(...args) { console.error(...args) } }
const logger = verbose
  ? { info: (...a) => console.log('  ·', ...a), warn: (...a) => console.warn('  !', ...a), error: (...a) => console.error('  x', ...a) }
  : quiet

let config
try {
  config = resolveConfig({ profile }, { env: process.env })
} catch (error) {
  console.error(`configuration rejected: ${error.message}`)
  process.exit(2)
}

const hostHome = dshHome.length > 0 ? dshHome : config.dataDir.replace(/\/multi-user\/?$/, '')
if (!existsSync(join(hostHome, 'profiles', profile))) {
  console.error(`no host profile at ${join(hostHome, 'profiles', profile)} — pass --dsh-home pointing at the DSH home`)
  process.exit(2)
}

const store = createStore(config, logger)
const supervisor = createSupervisor(
  { ...config, idleTimeoutMinutes: 0 },
  {
    logger,
    hostHome: () => hostHome,
    claimSlot: async (username) => {
      const used = store.snapshot().users.map((entry) => entry.slot).filter((value) => Number.isInteger(value))
      const slot = used.length === 0 ? 0 : Math.max(...used) + 1
      await store.update(username, { slot })
      return slot
    },
  },
)

const users = store.snapshot().users.filter((entry) => only === undefined || entry.username === only)
if (users.length === 0) {
  console.error(only === undefined ? 'no accounts exist yet' : `no such account: ${only}`)
  process.exit(only === undefined ? 0 : 2)
}

console.log(`dsh-multi-user — syncing profiles/${profile} for ${users.length} account(s)`)
console.log(`  host home : ${hostHome}`)
console.log(`  data dir  : ${config.dataDir}`)
console.log(`  overrides : ${config.userProfilePatch.trim().length > 0 ? 'yes (userProfilePatch is set)' : 'none'}`)
console.log()

let failed = 0
let synced = 0
for (const user of users) {
  let result
  try {
    // eslint-disable-next-line no-await-in-loop -- one account at a time keeps the output readable
    result = await supervisor.syncProfile(user)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${user.username}: ${error.message}`)
    continue
  }
  if (result.synced !== true) {
    console.log(`  --   ${user.username}: skipped (${result.reason ?? 'unknown reason'})`)
    continue
  }
  if (result.changed === true) synced += 1
  const state = result.changed === true ? 'synced ' : 'level  '
  const bits = [
    `${result.apps?.length ?? 0} app(s)`,
    result.files?.length ? `${result.files.length} file(s) mirrored` : 'no files copied',
  ]
  if (result.overrides) bits.push(`overrides ${result.overrides}`)
  if (result.patchApplied === false) bits.push('WARNING: the per-account patch could not be written')
  if (result.links?.length) bits.push(`linked ${result.links.join(', ')}`)
  console.log(`  ${state} ${user.username}: ${bits.join(' · ')}`)
  if (result.apps?.length) console.log(`         ${result.apps.join(', ')}`)
}

console.log()
console.log(`${synced} account(s) updated, ${users.length - synced - failed} already level, ${failed} failed.`)
process.exit(failed === 0 ? 0 : 1)
