#!/usr/bin/env node
/**
 * check_password.mjs — the self-service password change, end to end.
 *
 * Boots a real gateway over a real store with a stub supervisor (no upstream is
 * needed: changing a password never proxies anywhere) and drives the HTTP
 * surface exactly as the account page's fetch() does.
 *
 * Usage: node tools/check_password.mjs
 * Exit code 0 = all checks passed, 1 = failures, 2 = setup problem.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  console.error(`cannot locate the plugin entry; tried:\n  ${CANDIDATES.join('\n  ')}`)
  process.exit(2)
}
const {
  resolveConfig,
  createStore,
  createSessionManager,
  createAdmin,
  createGateway,
} = await import(moduleUrl.href)

const SESSION_COOKIE = 'dsh_mu_session'
let passed = 0
const failures = []
async function check(label, fn) {
  try {
    await fn()
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

const root = mkdtempSync(join(tmpdir(), 'dshmu-pw-'))
const quiet = { info() {}, warn() {}, error() {} }
const config = resolveConfig(
  { dataDir: join(root, 'multi-user'), listenPort: 0, bootstrapAdmin: false, idleTimeoutMinutes: 0 },
  { env: {}, cwd: root },
)
const store = createStore(config, quiet)
const sessions = createSessionManager(config, quiet)
const supervisorStub = {
  homeOf: (user) => join(config.usersDir, user.username, 'home'),
  workspaceOf: (user) => join(config.usersDir, user.username, 'workspace'),
  dataDirOf: (username) => join(config.usersDir, username),
  ensureSpace: (user) => ({ home: supervisorStub.homeOf(user), workspace: supervisorStub.workspaceOf(user) }),
  seedUserHome: () => [],
  syncProfile: () => ({ synced: true, apps: [] }),
  profileInfo: () => ({ inheritProfile: true, profile: 'web', syncOnStart: true }),
  hostApps: () => [],
  stop: () => true,
  status: () => [],
  launcher: () => ({ bin: 'pnpm', args: ['dsh'] }),
  async acquire() {
    throw new Error('no upstream in this harness')
  },
}
const admin = createAdmin({ config, store, sessions, supervisor: supervisorStub, logger: quiet })
const gateway = createGateway({
  config,
  store,
  sessions,
  supervisor: supervisorStub,
  admin,
  logger: quiet,
  trustProxy: false,
})
const base = `http://127.0.0.1:${await gateway.listen()}`

const jar = {}
async function call(path, options = {}, who = 'anon') {
  const response = await fetch(`${base}${path}`, {
    redirect: 'manual',
    ...options,
    headers: { cookie: jar[who] ?? '', ...(options.headers ?? {}) },
  })
  const setCookie = response.headers.getSetCookie?.() ?? []
  const own = setCookie.find((entry) => entry.startsWith(`${SESSION_COOKIE}=`))
  if (own !== undefined) jar[who] = own.split(';')[0]
  const type = response.headers.get('content-type') ?? ''
  const body = type.includes('json') ? await response.json() : await response.text()
  return { status: response.status, body }
}
const json = (payload) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })

const ADMIN_PW = 'admin-secret-1'
const ALICE_PW = 'alice-secret-1'
const NEW_PW = 'alice-secret-2'

await check('setup: an administrator and an ordinary account exist', async () => {
  const a = await admin.create({ username: 'admin', password: ADMIN_PW, role: 'admin' })
  assert(!a.error, `could not create the administrator: ${a.error}`)
  const b = await admin.create({ username: 'alice', password: ALICE_PW, role: 'user' })
  assert(!b.error, `could not create alice: ${b.error}`)
})

await check('an anonymous password change is refused', async () => {
  const response = await call('/mu/api/password', json({ currentPassword: ALICE_PW, newPassword: NEW_PW }))
  assert(response.status === 401, `expected 401, got ${response.status}`)
})

await check('an ordinary account can sign in', async () => {
  const response = await call('/mu/api/login', json({ username: 'alice', password: ALICE_PW }), 'alice')
  assert(response.status === 302, `expected 302, got ${response.status}`)
  const me = await call('/mu/api/me', {}, 'alice')
  assert(me.status === 200, `expected a session, got ${me.status}`)
  assert(me.body.user?.username === 'alice', 'the session belongs to the wrong account')
})

await check('the account page offers the change-password form', async () => {
  const response = await call('/mu/account', { headers: { accept: 'text/html' } }, 'alice')
  assert(response.status === 200, `expected 200, got ${response.status}`)
  assert(response.body.includes('pw-submit'), 'the form has no submit button')
  assert(response.body.includes('/api/password'), 'the form does not post to the password endpoint')
  assert(response.body.includes('当前密码'), 'the form does not ask for the current password')
})

await check('a wrong current password is refused', async () => {
  const response = await call('/mu/api/password', json({ currentPassword: 'not-the-password', newPassword: NEW_PW }), 'alice')
  assert(response.status === 403, `expected 403, got ${response.status}`)
  const stillWorks = await call('/mu/api/login', json({ username: 'alice', password: ALICE_PW }), 'probe')
  assert(stillWorks.status === 302, 'a refused change must not alter the password')
})

await check('too-short and mismatched passwords are refused', async () => {
  const short = await call('/mu/api/password', json({ currentPassword: ALICE_PW, newPassword: 'x' }), 'alice')
  assert(short.status === 400, `a one-character password should be 400, got ${short.status}`)
  const mismatch = await call(
    '/mu/api/password',
    json({ currentPassword: ALICE_PW, newPassword: NEW_PW, confirmPassword: `${NEW_PW}-typo` }),
    'alice',
  )
  assert(mismatch.status === 400, `a mismatched confirmation should be 400, got ${mismatch.status}`)
  const same = await call('/mu/api/password', json({ currentPassword: ALICE_PW, newPassword: ALICE_PW }), 'alice')
  assert(same.status === 400, `reusing the current password should be 400, got ${same.status}`)
})

await check('a second session exists, to be revoked by the change', async () => {
  const other = await call('/mu/api/login', json({ username: 'alice', password: ALICE_PW }), 'alice-other-device')
  assert(other.status === 302, `expected 302, got ${other.status}`)
  const me = await call('/mu/api/me', {}, 'alice-other-device')
  assert(me.status === 200, 'the second session did not take')
})

await check('changing your own password succeeds and keeps this tab signed in', async () => {
  const response = await call(
    '/mu/api/password',
    json({ currentPassword: ALICE_PW, newPassword: NEW_PW, confirmPassword: NEW_PW }),
    'alice',
  )
  assert(response.status === 200, `expected 200, got ${response.status} (${JSON.stringify(response.body)})`)
  const me = await call('/mu/api/me', {}, 'alice')
  assert(me.status === 200, 'the caller was signed out by its own password change')
})

await check('the other session is revoked by the change', async () => {
  const me = await call('/mu/api/me', {}, 'alice-other-device')
  assert(me.status === 401, `expected the other device to be signed out, got ${me.status}`)
})

await check('the new password works and the old one does not', async () => {
  const old = await call('/mu/api/login', json({ username: 'alice', password: ALICE_PW }), 'probe')
  assert(old.status !== 302, `the old password still works (HTTP ${old.status})`)
  const fresh = await call('/mu/api/login', json({ username: 'alice', password: NEW_PW }), 'probe')
  assert(fresh.status === 302, `the new password does not work (HTTP ${fresh.status})`)
})

await check('an administrator can change their own password too', async () => {
  const signIn = await call('/mu/api/login', json({ username: 'admin', password: ADMIN_PW }), 'admin')
  assert(signIn.status === 302, `expected 302, got ${signIn.status}`)
  const changed = await call(
    '/mu/api/password',
    json({ currentPassword: ADMIN_PW, newPassword: 'admin-secret-9', confirmPassword: 'admin-secret-9' }),
    'admin',
  )
  assert(changed.status === 200, `expected 200, got ${changed.status} (${JSON.stringify(changed.body)})`)
  const me = await call('/mu/api/me', {}, 'admin')
  assert(me.status === 200 && me.body.user.role === 'admin', 'the administrator lost their session or role')
})

await gateway.close()
rmSync(root, { recursive: true, force: true })

console.log(`\n${passed} checks passed${failures.length === 0 ? '' : ` — with ${failures.length} failure(s)`}\n`)
process.exit(failures.length === 0 ? 0 : 1)
