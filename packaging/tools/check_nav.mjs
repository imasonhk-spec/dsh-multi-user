#!/usr/bin/env node
/**
 * dsh-multi-user — navigation regression guard.
 *
 * Runs against a *live* gateway, so it works the same locally, through nginx,
 * and on a remote host.
 *
 *   node tools/check_nav.mjs --base https://127.0.0.1:3082 \
 *        --user admin --password '...'
 *
 * It exists because of a real bug: the console's "返回工作台" button pointed at
 * `${base}/`, which is role-aware, so an admin was redirected straight back to
 * the console and the click looked like it did nothing. Two invariants keep that
 * from coming back:
 *
 *   1. `${base}/workspace` must always land on the workspace, for every role.
 *   2. The console must not use `${base}/` as a "go to workspace" link, and must
 *      not nest a <button> inside an <a> (invalid, browser-dependent).
 *
 * Exit code = number of failed checks.
 */

const args = new Map()
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i]
  if (token.startsWith('--')) args.set(token, process.argv[i + 1])
}

const BASE = (args.get('--base') ?? 'http://127.0.0.1:3090').replace(/\/$/, '')
const USER = args.get('--user') ?? 'admin'
const PASSWORD = args.get('--password')
const BASE_PATH = args.get('--base-path') ?? '/mu'
const INSECURE = process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'

if (!PASSWORD) {
  process.stderr.write('missing --password\n')
  process.exit(2)
}

let failures = 0
const check = (ok, name, detail = '') => {
  if (ok) {
    console.log(`  ok   ${name}${detail ? `\n         ${detail}` : ''}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`)
  }
}

/** Fetch without following redirects, so we can assert on the target. */
async function probe(path, { cookie, html = false } = {}) {
  const headers = {}
  if (cookie) headers.cookie = cookie
  if (html) headers.accept = 'text/html,application/xhtml+xml'
  const response = await fetch(`${BASE}${path}`, { redirect: 'manual', headers })
  const body = html || response.headers.get('content-type')?.includes('text/html')
    ? await response.text()
    : ''
  return { status: response.status, location: response.headers.get('location') ?? '', body, headers: response.headers }
}

/** Normalise a Location header to an absolute URL for comparison. */
const toUrl = (location) => (location ? new URL(location, BASE).toString() : '')

console.log(`\ndsh-multi-user navigation guard — ${BASE}${INSECURE ? '  (TLS verification off)' : ''}\n`)

if (INSECURE) process.emitWarning('TLS verification disabled', { code: 'DSHMU' })

// ── sign in ──────────────────────────────────────────────────────────────────
const login = await fetch(`${BASE}${BASE_PATH}/api/login`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: USER, password: PASSWORD }).toString(),
})
const setCookie = login.headers.get('set-cookie') ?? ''
const cookie = setCookie.split(';')[0]
check(login.status === 302 && cookie.includes('='), 'sign in mints a session',
  `HTTP ${login.status}${cookie ? '' : ' (no cookie)'}`)

if (!cookie) {
  console.log(`\n${failures} failed — cannot continue without a session\n`)
  process.exit(failures)
}

// ── 1. the workspace entry point is unambiguous ──────────────────────────────
const workspace = await probe(`${BASE_PATH}/workspace`, { cookie, html: true })
check(workspace.status === 302 && new URL(toUrl(workspace.location)).pathname === '/',
  `${BASE_PATH}/workspace redirects to the workspace`,
  `HTTP ${workspace.status} -> ${workspace.location || '(none)'}`)

const direct = await probe('/', { cookie, html: true })
check(direct.status === 200, 'the workspace itself answers 200', `HTTP ${direct.status}`)

// ── 2. the console no longer links "workspace" at the role-aware root ────────
const consolePage = await probe(`${BASE_PATH}/admin`, { cookie, html: true })
check(consolePage.status === 200, 'the admin console renders', `HTTP ${consolePage.status}`)

const rootLink = new RegExp(`href="${BASE_PATH}/"`)
check(!rootLink.test(consolePage.body),
  `the console does not link to "${BASE_PATH}/" as a destination`,
  rootLink.test(consolePage.body) ? `found href="${BASE_PATH}/" — for an admin that redirects back to the console` : '')

const nestedButton = /<a\b[^>]*>\s*<button/i
check(!nestedButton.test(consolePage.body),
  'the console nests no <button> inside an <a>',
  nestedButton.test(consolePage.body) ? 'interactive content inside <a> is invalid and browser-dependent' : '')

check(consolePage.body.includes(`href="${BASE_PATH}/workspace"`),
  'the console links to the workspace entry point')

// ── 3. role-aware root still behaves, but is not used for navigation ─────────
const root = await probe(`${BASE_PATH}/`, { cookie, html: true })
check(root.status === 302, `GET ${BASE_PATH}/ still redirects (role-aware)`, `HTTP ${root.status} -> ${root.location || '(none)'}`)

console.log(`\n${failures === 0 ? 'all navigation checks passed' : `${failures} failed`}\n`)
process.exit(failures)
