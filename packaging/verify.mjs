/**
 * dsh-multi-user — portable verifier.
 *
 * Checks are ordered cheapest-first so a broken install fails fast. The exit
 * code is the number of failed checks, so `./verify.sh && echo OK` is usable
 * in a script.
 *
 * Usage:
 *   node verify.mjs                          # auto-detect everything
 *   node verify.mjs --base http://host:3090 --user admin --password 'xxx'
 *   node verify.mjs --deep                   # also spawn a real per-user instance
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

/** Every module the plugin needs to boot; compared byte-for-byte after install. */
const LIB_FILES = ['index.js', 'gateway.js', 'store.js', 'sessions.js', 'supervisor.js', 'admin.js', 'admin-ui.js', 'tools.js', 'config.js']
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex')

const args = new Map()
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index]
  if (!token.startsWith('--')) continue
  const next = process.argv[index + 1]
  if (next === undefined || next.startsWith('--')) args.set(token, true)
  else { args.set(token, next); index += 1 }
}

const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const PKG_NAME = 'dsh-multi-user'
const DSH_HOME = args.get('--dsh-home') ?? process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
const PROFILE = args.get('--profile') ?? process.env.PROFILE ?? 'web'
const PORT = Number(args.get('--port') ?? process.env.GATEWAY_PORT ?? 3090)
const BASE = args.get('--base') ?? `http://127.0.0.1:${PORT}`
const DEEP = args.get('--deep') === true

let failures = 0
let passed = 0
const log = (mark, label, detail = '') => {
  const tag = mark === 'ok' ? '\u001B[32mok  \u001B[0m' : mark === 'skip' ? '\u001B[33mskip\u001B[0m' : '\u001B[31mFAIL\u001B[0m'
  console.log(`  ${tag} ${label}${detail === '' ? '' : `\n         ${detail}`}`)
  if (mark === 'ok') passed += 1
  if (mark === 'FAIL') failures += 1
}
const check = (label, fn) => {
  try {
    const detail = fn()
    log('ok', label, detail === undefined ? '' : String(detail))
  } catch (error) {
    log('FAIL', label, error.message)
  }
}
const checkAsync = async (label, fn) => {
  try {
    const detail = await fn()
    log('ok', label, detail === undefined ? '' : String(detail))
  } catch (error) {
    log('FAIL', label, error.message)
  }
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

/** Read the bootstrap admin credentials written on first start. */
function bootstrapCredentials() {
  const explicitUser = args.get('--user')
  const explicitPassword = args.get('--password')
  if (typeof explicitUser === 'string' && typeof explicitPassword === 'string') {
    return { username: explicitUser, password: explicitPassword }
  }
  const notice = join(DSH_HOME, 'multi-user', 'INITIAL_ADMIN.txt')
  if (!existsSync(notice)) return undefined
  const text = readFileSync(notice, 'utf8')
  const username = /用户名:\s*(\S+)/.exec(text)?.[1]
  const password = /密码:\s*(\S+)/.exec(text)?.[1]
  if (username === undefined || password === undefined) return undefined
  return { username, password }
}

/** Minimal cookie-jar HTTP client, mirroring what a browser does. */
function makeClient() {
  const jar = new Map()
  return {
    async request(path, { method = 'GET', body, headers = {}, json = true, browser = false } = {}) {
      const merged = {
        ...(browser ? { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } : { accept: 'application/json' }),
        ...headers,
      }
      if (jar.size > 0) merged.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
      if (body !== undefined && merged['content-type'] === undefined) merged['content-type'] = 'application/json'
      const response = await fetch(`${BASE}${path}`, {
        method,
        headers: merged,
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
        redirect: 'manual',
      })
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';')
        const at = pair.indexOf('=')
        jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
      }
      const type = response.headers.get('content-type') ?? ''
      const text = await response.text()
      let parsed
      if (json && type.includes('json')) {
        try { parsed = JSON.parse(text) } catch { parsed = undefined }
      }
      return { status: response.status, headers: response.headers, text, body: parsed }
    },
    clear: () => jar.clear(),
  }
}

console.log(`\ndsh-multi-user verifier — ${BASE}  (DSH_HOME=${DSH_HOME}, profile=${PROFILE})\n`)
console.log('[1] payload and profile wiring')

check('the shipped artifacts are all present', () => {
  const manifest = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8'))
  assert(existsSync(join(HERE, 'plugin', `dsh-multi-user-${manifest.version}.tgz`)), 'the plugin tarball is missing')
  for (const entry of manifest.files) {
    assert(existsSync(join(HERE, entry.path)), `manifest entry missing on disk: ${entry.path}`)
    const size = statSync(join(HERE, entry.path)).size
    assert(size === entry.size, `${entry.path}: size ${size} != manifest ${entry.size}`)
  }
  return `${manifest.files.length} files verified`
})

check('the payload carries every file the plugin needs to boot', () => {
  const root = join(HERE, 'payload', 'dsh-multi-user')
  const required = [
    'package.json',
    'cordis.patch.yml',
    'lib/index.js',
    'lib/gateway.js',
    'lib/store.js',
    'lib/sessions.js',
    'lib/supervisor.js',
    'lib/admin.js',
    'lib/admin-ui.js',
    'lib/tools.js',
    'lib/config.js',
  ]
  for (const relative of required) {
    assert(existsSync(join(root, relative)), `payload is missing ${relative}`)
  }
  // The bundle patch is what makes DSH load the plugin at all.
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert(patch.includes('dsh-multi-user'), 'cordis.patch.yml does not insert the dsh-multi-user row')
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert(manifest.dsh?.bundle?.patch !== undefined, 'package.json declares no dsh.bundle.patch')
  assert(manifest.dependencies === undefined, 'the plugin must stay dependency-free to remain portable')
  return `${required.length} entry points · dsh.bundle.patch=${manifest.dsh.bundle.patch}`
})

check('the profile manifest depends on the plugin exactly once', () => {
  const file = join(DSH_HOME, 'profiles', PROFILE, 'package.json')
  assert(existsSync(file), `missing ${file}`)
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  const bundles = manifest?.dsh?.profile?.bundles ?? []
  const occurrences = bundles.filter((name) => name === PKG_NAME).length
  assert(occurrences === 1, `dsh.profile.bundles lists ${PKG_NAME} ${occurrences} times (expected 1)`)
  const dependency = manifest?.dependencies?.[PKG_NAME]
  assert(typeof dependency === 'string', `package.json has no dependency on ${PKG_NAME}`)
  assert(bundles.includes('@deepseek-ai/dsh-base'), 'the in-box dsh-base bundle disappeared from the roster')
  return `${PKG_NAME} <- ${dependency}`
})

check('the installed package matches the shipped payload', () => {
  const installedDir = join(DSH_HOME, 'profiles', PROFILE, 'node_modules', PKG_NAME)
  const installed = join(installedDir, 'package.json')
  assert(existsSync(installed), `package not materialized at ${installed}`)
  const manifest = JSON.parse(readFileSync(installed, 'utf8'))
  const shipped = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8'))
  assert(manifest.version === shipped.version, `installed ${manifest.version} != shipped ${shipped.version}`)
  assert(manifest.dsh?.bundle?.patch !== undefined, 'the installed manifest declares no dsh.bundle.patch')
  // Content, not just version. pnpm resolves `file:` dependencies by specifier,
  // so shipping changed code under an unchanged version can leave the previous
  // copy linked — the install looks clean while the old behaviour persists.
  for (const name of LIB_FILES) {
    const target = join(installedDir, 'lib', name)
    assert(existsSync(target), `lib/${name} is missing from the installed package`)
    const mine = digest(readFileSync(target))
    const theirs = digest(readFileSync(join(HERE, 'payload', PKG_NAME, 'lib', name)))
    assert(mine === theirs, `lib/${name} installed (${mine.slice(0, 12)}) != shipped (${theirs.slice(0, 12)}) — the profile is running stale code`)
  }
  return `${manifest.version} · ${LIB_FILES.length} files byte-identical to the payload`
})

check('the plugin tarball has the layout pnpm requires', () => {
  const manifest = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8'))
  const tgz = join(HERE, 'plugin', `dsh-multi-user-${manifest.version}.tgz`)
  assert(existsSync(tgz), `missing ${tgz}`)
  const listing = execFileSync('tar', ['tzf', tgz], { encoding: 'utf8' }).split('\n').filter((line) => line.length > 0)
  assert(listing.length > 0, 'the tarball is empty')
  const bad = listing.filter((name) => name !== './' && !name.startsWith('package/'))
  assert(bad.length === 0, `entries outside package/: ${bad.slice(0, 3).join(', ')}`)
  for (const required of ['package/package.json', 'package/cordis.patch.yml', 'package/lib/index.js']) {
    assert(listing.includes(required), `tarball is missing ${required}`)
  }
  return `${listing.length} entries`
})

console.log('\n[2] gateway reachability and gate')

const client = makeClient()

await checkAsync('the login page answers on the gateway port', async () => {
  const response = await client.request('/mu/login', { browser: true })
  assert(response.status === 200, `expected 200, got ${response.status}`)
  assert(response.text.includes('DSH 多用户网关'), 'the login page body is not the gateway login form')
  return `${response.text.length} bytes`
})

await checkAsync('an anonymous navigation is redirected to the login page', async () => {
  const response = await client.request('/', { browser: true })
  assert(response.status === 302, `expected 302, got ${response.status}`)
  assert(response.headers.get('location') === '/mu/login', `unexpected redirect target ${response.headers.get('location')}`)
})

await checkAsync('an anonymous API call is refused with 401', async () => {
  const response = await client.request('/api/session.list', { method: 'POST', body: {} })
  assert(response.status === 401, `expected 401, got ${response.status}`)
})

await checkAsync('a wrong password does not mint a session', async () => {
  const response = await client.request('/mu/api/login', {
    method: 'POST',
    body: { username: '__definitely_not_a_user__', password: 'nope' },
  })
  assert(response.status === 401, `expected 401, got ${response.status}`)
})

console.log('\n[3] administrator surface')

const credentials = bootstrapCredentials()
let adminSession = false

if (credentials === undefined) {
  log('skip', 'administrator checks', 'no credentials found — pass --user/--password or restore multi-user/INITIAL_ADMIN.txt')
} else {
  await checkAsync(`sign in as ${credentials.username}`, async () => {
    const response = await client.request('/mu/api/login', {
      method: 'POST',
      body: { username: credentials.username, password: credentials.password },
    })
    assert(response.status === 302, `expected 302, got ${response.status}`)
    adminSession = true
    return `-> ${response.headers.get('location')}`
  })

  await checkAsync('the admin console renders', async () => {
    assert(adminSession, 'not signed in')
    const response = await client.request('/mu/admin', { browser: true })
    assert(response.status === 200, `expected 200, got ${response.status}`)
    assert(response.text.includes('用户管理'), 'the console body is missing the user-management view')
    assert(response.text.includes('批量导入'), 'the console body is missing the bulk-import view')
  })

  await checkAsync('the console reaches the workspace without bouncing back', async () => {
    assert(adminSession, 'not signed in')
    const consolePage = await client.request('/mu/admin', { browser: true })
    assert(consolePage.status === 200, `expected 200, got ${consolePage.status}`)
    // Regression: the console used to point "返回工作台" at /mu/, which is
    // role-aware and sends an admin straight back to the console, so the click
    // appeared to do nothing.
    assert(!/<a\b[^>]*>\s*<button/i.test(consolePage.text), 'the console nests a <button> inside an <a> (invalid, browser-dependent)')
    assert(!consolePage.text.includes('href="/mu/"'), 'the console still links to /mu/ as a destination — that is the role-aware root, not the workspace')
    assert(consolePage.text.includes('href="/mu/workspace"'), 'the console exposes no workspace entry link')
    const workspace = await client.request('/mu/workspace', { browser: true })
    assert(workspace.status === 302, `expected 302, got ${workspace.status}`)
    const target = new URL(workspace.headers.get('location') ?? '', BASE).pathname
    assert(target === '/', `/mu/workspace should land on the workspace, got ${target}`)
    const landed = await client.request('/', { browser: true })
    assert(landed.status === 200, `the workspace itself answered ${landed.status}`)
    return '/mu/workspace -> / (200)'
  })

  await checkAsync('the user API lists accounts without password hashes', async () => {
    assert(adminSession, 'not signed in')
    const response = await client.request('/mu/api/users')
    assert(response.status === 200, `expected 200, got ${response.status}`)
    assert(Array.isArray(response.body?.users), 'response has no users array')
    assert(response.body.users.every((user) => !('passwordHash' in user)), 'a password hash leaked into the API response')
    return `${response.body.users.length} account(s)`
  })

  await checkAsync('the status API reports the gateway configuration', async () => {
    assert(adminSession, 'not signed in')
    const response = await client.request('/mu/api/status')
    assert(response.status === 200, `expected 200, got ${response.status}`)
    assert(response.body?.gateway?.listenPort > 0, 'status has no listen port')
    return `users=${response.body.gateway.users} sessions=${response.body.gateway.sessions} adminHomeMode=${response.body.gateway.adminHomeMode}`
  })
}

console.log('\n[4] end-to-end per-user isolation')

if (!DEEP) {
  log('skip', 'per-user isolation proof', 'pass --deep (spawns a real per-user DSH instance, takes ~1 min)')
} else if (!adminSession) {
  log('skip', 'per-user isolation proof', 'administrator session unavailable')
} else {
  const stamp = Date.now().toString(36)
  const probe = `vfy${stamp}`
  const password = `Vfy-${stamp}-Aa1`
  const probeClient = makeClient()
  let created = false

  await checkAsync('create a probe account through the API', async () => {
    const response = await client.request('/mu/api/users', {
      method: 'POST',
      body: { username: probe, password, role: 'user', note: 'verify.mjs probe' },
    })
    assert(response.status === 201, `expected 201, got ${response.status}: ${response.text.slice(0, 200)}`)
    created = true
    const home = response.body.homeDir
    assert(typeof home === 'string' && home.length > 0, 'no homeDir returned')
    assert(existsSync(home), `the private home was not created at ${home}`)
    assert(existsSync(response.body.workspaceDir), `the private workspace was not created at ${response.body.workspaceDir}`)
    return home
  })

  await checkAsync('the probe account can sign in and reaches its own upstream', async () => {
    assert(created, 'the probe account was not created')
    const login = await probeClient.request('/mu/api/login', { method: 'POST', body: { username: probe, password } })
    assert(login.status === 302, `login returned ${login.status}`)
    // First hit spawns the account's own DSH process; allow for a cold start.
    const deadline = Date.now() + 180_000
    let last = ''
    for (;;) {
      const response = await probeClient.request('/', { browser: true })
      if (response.status === 200 && response.text.includes('data-dsh-multi-user="widget"')) {
        assert(response.text.includes(probe), 'the injected widget does not name the signed-in account')
        return 'served by the probe account\'s own instance'
      }
      last = `status ${response.status}`
      if (Date.now() > deadline) throw new Error(`no proxied page after 180s (last ${last}; see the instance log under <dataDir>/logs)`)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 3000))
    }
  })

  await checkAsync('the two accounts see different, independent DSH homes', async () => {
    const adminStatus = await client.request('/mu/api/status')
    const instances = adminStatus.body?.instances ?? []
    const found = instances.find((entry) => entry.username === probe)
    assert(found !== undefined, `the gateway reports no running instance for ${probe}`)
    assert(found.homeDir.includes(probe), `instance home ${found.homeDir} does not belong to ${probe}`)
    assert(found.alive === true, `instance for ${probe} is not alive`)
    return `${probe} -> 127.0.0.1:${found.port} @ ${found.homeDir}`
  })

  await checkAsync('the probe account inherits the host application set', () => {
    assert(created, 'the probe account was not created')
    const profileDir = join(DSH_HOME, 'multi-user', 'users', probe, 'home', 'profiles', PROFILE)
    const probeManifest = join(profileDir, 'package.json')
    assert(
      existsSync(probeManifest),
      `the probe space has no profile manifest at ${probeManifest} — apps are not being inherited`,
    )
    const probeBundles = JSON.parse(readFileSync(probeManifest, 'utf8'))?.dsh?.profile?.bundles ?? []
    assert(Array.isArray(probeBundles) && probeBundles.length > 0, 'the probe manifest declares no bundles')
    const hostManifest = join(DSH_HOME, 'profiles', PROFILE, 'package.json')
    const hostBundles = existsSync(hostManifest)
      ? (JSON.parse(readFileSync(hostManifest, 'utf8'))?.dsh?.profile?.bundles ?? [])
      : []
    const missing = hostBundles.filter((name) => !probeBundles.includes(name))
    assert(missing.length === 0, `the probe space is missing host apps: ${missing.join(', ')}`)
    assert(existsSync(join(profileDir, 'node_modules')), 'the probe space has no installed node_modules')
    return `${probeBundles.length} bundle(s) mirrored (host declares ${hostBundles.length})`
  })

  await checkAsync('the probe account cannot reach the admin API', async () => {
    const response = await probeClient.request('/mu/api/users')
    assert(response.status === 403, `expected 403 for a plain user, got ${response.status}`)
  })

  await checkAsync('delete the probe account and purge its space', async () => {
    assert(created, 'nothing to clean up')
    const response = await client.request(`/mu/api/users/${probe}?purge=true`, { method: 'DELETE' })
    assert(response.status === 200, `expected 200, got ${response.status}: ${response.text.slice(0, 200)}`)
    assert(response.body.purged === true, 'the probe space was not purged')
    const after = await client.request('/mu/api/users')
    assert(after.body.users.every((user) => user.username !== probe), 'the probe account is still listed')
    return 'probe account and its data removed'
  })
}

console.log(`\n${passed} passed, ${failures} failed\n`)
process.exit(Math.min(failures, 200))
