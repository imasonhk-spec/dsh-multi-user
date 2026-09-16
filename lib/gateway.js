/**
 * dsh-multi-user — the gateway itself.
 *
 * One `node:http` server owns the public port. It answers the login page, the
 * administrator console and the REST API under `basePath`; every other request
 * is forwarded to the DSH instance belonging to the signed-in account.
 *
 * Because each account has its own upstream instance, the gateway never has to
 * filter another tenant's data out of a response: there is nothing of theirs to
 * filter. That is why the isolation here is complete rather than best-effort.
 *
 * The browser never sees the upstream's own `dsh-auth-*` cookie — the gateway
 * keeps it and rewrites `Host` to loopback, which is also what lets it satisfy
 * DSH's DNS-rebinding fence without putting the upstream on the network.
 *
 * @module dsh-multi-user/gateway
 */

import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { join, resolve as resolvePath, sep } from 'node:path'
import {
  SESSION_COOKIE,
  clearCookie,
  readCookie,
  sessionCookie,
} from './sessions.js'
import { verifyPassword } from './store.js'
import { isAdministrator } from './supervisor.js'
import {
  MAX_IMPORT_ROWS,
  buildUserTemplate,
  buildUserTemplateCsv,
  readUserTable,
} from './spreadsheet.js'
import {
  adminPage,
  accountPage,
  errorPage,
  escapeHtml,
  loginPage,
  logoutWidget,
  startingPage,
} from './admin-ui.js'

/** Hop-by-hop headers that must not be forwarded in either direction. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Upper bound on a proxied HTML body we are willing to rewrite in memory. */
const HTML_REWRITE_LIMIT = 4 * 1024 * 1024

/**
 * Configuration the administrator owns outright.
 *
 * A settings namespace, or a credential scope, whose name starts with this
 * prefix is the model catalogue: providers, endpoints, API keys, the official
 * DeepSeek model list. Model configuration is an administrator surface — the
 * account only *uses* models.
 *
 * Two deliberate boundaries. A settings namespace is fenced whole, so no model
 * can be added or repointed; `agent-default-model` (which model this account
 * talks to) is a different namespace and stays the account's own choice. On the
 * credentials domain only *scoped* model references are fenced
 * (`llm-pi-ai/<provider>`), because the 插件 → 联网搜索 card legitimately writes
 * a search key through the same domain — and a bare provider key such as
 * `DEEPSEEK_API_KEY` is indistinguishable from that search key, so it is left
 * writable. It grants nothing on its own: attaching a key to a model is an
 * `llm-*` settings write, which is refused below.
 */
const ADMIN_ONLY_CONFIG_PREFIX = 'llm-'

/**
 * RPC endpoints whose named arguments carry a settings namespace.
 *
 * The wire path is `/api/<namespace>/<method>` — verified against a live
 * administrator session, not assumed: `/api/settings.describe` answers `404
 * not found` while `/api/settings/describe` dispatches.
 */
const SETTINGS_WRITE_ENDPOINTS = new Set([
  '/api/settings/update',
  '/api/settings/replace',
  '/api/settings/mutate',
])

/** RPC endpoints whose named arguments carry a credential reference. */
const CREDENTIAL_WRITE_ENDPOINTS = new Set([
  '/api/credentials/set',
  '/api/credentials/unset',
])

/** Upper bound on a guarded RPC body we buffer in order to inspect it. */
const GUARDED_BODY_LIMIT = 4 * 1024 * 1024

/** Whether one settings namespace / credential scope is administrator-owned. */
function isAdminOnlyConfigScope(scope) {
  return scope === 'llm' || scope.startsWith(ADMIN_ONLY_CONFIG_PREFIX)
}

/**
 * Read the configuration scope a guarded RPC names, if it names one at all.
 *
 * Verified against the live wire: `payload.args` is one plain object of NAMED
 * arguments — `{ ns, patch, expectedRevision }` for a settings write,
 * `{ ref, value }` for a credential write. A positional array is tolerated too,
 * so an alternate caller cannot slip past the fence by changing shape.
 *
 * @param envelope - the decoded `client-request` body.
 * @param wantsSettings - whether the endpoint is a settings write.
 * @returns the namespace / credential reference, or undefined.
 */
function configScopeOf(envelope, wantsSettings) {
  const args = envelope?.payload?.args
  if (args === undefined || args === null) return undefined
  const positional = Array.isArray(args) ? args[0] : undefined
  const named = Array.isArray(args) ? undefined : (wantsSettings ? args.ns : args.ref)
  const scope = typeof named === 'string' && named.length > 0 ? named : positional
  const flat = typeof scope === 'string' ? scope : scope?.ns ?? scope?.ref
  return typeof flat === 'string' && flat.length > 0 ? flat : undefined
}

/** Picker endpoints: list one level, create a child directory, open the OS chooser. */
const PICKER_LIST_ENDPOINTS = new Set(['/api/directoryPicker/list'])
const PICKER_CREATE_ENDPOINTS = new Set(['/api/directoryPicker/createDirectory'])
const PICKER_NATIVE_ENDPOINTS = new Set(['/api/directoryPicker/pick'])

/** Workspace registration: the RPC that turns a chosen path into a workspace. */
const WORKSPACE_CREATE_ENDPOINTS = new Set(['/api/workspace/create'])

/**
 * File endpoints the right-hand sidebars drive.
 *
 * `list` is confined upstream, but every other verb is not — verified against a
 * live administrator session, where `workspaceFiles/list /home/lgsj` answers
 * `workspace-file/outside-workspace` while `workspaceFiles/readAll
 * /etc/hostname` answers `ok: true` with the file's bytes. The gateway is
 * therefore the only place the check can be made to hold for every verb.
 */
const WORKSPACE_FILE_ENDPOINTS = new Set([
  '/api/workspaceFiles/list',
  '/api/workspaceFiles/read',
  '/api/workspaceFiles/readAll',
  '/api/workspaceFiles/readBytes',
  '/api/workspaceFiles/readRelated',
  '/api/workspaceFiles/stat',
])

/**
 * Every RPC the browser-side terminal drives.
 *
 * The terminal is an administrator surface. A browser shell runs as the one
 * shared Linux user, so no amount of picker/file fencing contains it — it
 * reaches every account's tree. Ordinary accounts therefore get no terminal at
 * all, and this set is the wire half of that: the entry point is hidden by
 * their profile (`ui-sidebar-terminal` disabled) and a hand-rolled RPC cannot
 * open a shell either.
 *
 * `terminal/create` is the call that actually spawns a shell; refusing it alone
 * would already be sufficient, but the whole family is refused so no half-built
 * terminal state can be reached. `follow` is a streaming method and travels on
 * `/api/remote.mux` rather than its own path — it is listed for completeness and
 * is unreachable anyway without `create`.
 *
 * The agent's own command tools are untouched: they run in-process, never on
 * this wire, and are not what this fence is about.
 */
const TERMINAL_ENDPOINTS = new Set([
  '/api/terminal/close',
  '/api/terminal/create',
  '/api/terminal/environment',
  '/api/terminal/follow',
  '/api/terminal/list',
  '/api/terminal/rename',
  '/api/terminal/resize',
  '/api/terminal/shells',
  '/api/terminal/write',
])

/**
 * Where an ordinary account's own files begin.
 *
 * Every account shares one Linux user, so the filesystem draws no line between
 * them and this gateway is the only boundary there is. An ordinary account is
 * confined to its workspace area; its DSH home deliberately stays out of reach,
 * because that home carries a copy of the deployment's provider credentials.
 * The administrator is unrestricted — the whole tree is theirs to operate.
 *
 * @param user - the authenticated account record.
 * @returns the absolute root, or `null` meaning "no restriction".
 */
function scopeRootOf(user) {
  if (isAdministrator(user)) return null
  if (typeof user?.workspaceDir === 'string' && user.workspaceDir.length > 0) {
    return resolvePath(user.workspaceDir)
  }
  if (typeof user?.homeDir === 'string' && user.homeDir.length > 0) {
    return resolvePath(join(user.homeDir, '..', 'workspace'))
  }
  return null
}

/** Whether `candidate` is `root` itself or lives underneath it. */
function insideScope(root, candidate) {
  if (typeof root !== 'string' || root.length === 0) return true
  if (typeof candidate !== 'string' || candidate.length === 0) return false
  const target = resolvePath(candidate)
  if (target === root) return true
  return target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/** Whether a wire path carries a parent segment that could climb out of a root. */
function climbsOut(candidate) {
  return String(candidate ?? '').split(/[\\/]/).some((segment) => segment === '..')
}

/** Whether a wire path is absolute, in either platform's spelling. */
function isAbsolutePath(candidate) {
  return typeof candidate === 'string'
    && (candidate.startsWith('/') || /^[A-Za-z]:[\\/]/.test(candidate))
}

/** Read one named argument in either wire shape a caller may use. */
function namedArg(args, key, index) {
  if (args === undefined || args === null) return undefined
  return Array.isArray(args) ? args[index] : args[key]
}

/** Write one named argument back in the shape the caller used. */
function setNamedArg(args, key, index, value) {
  if (Array.isArray(args)) {
    args[index] = value
    return
  }
  args[key] = value
}

/**
 * Breadcrumb rows for the account's own scope.
 *
 * The picker renders whatever crumbs a listing carries and lets every one of
 * them be clicked, so an ancestry that still reached `/` would offer jumps the
 * fence then has to swallow. Re-rooting the chain at the scope root keeps the
 * browser's own navigation honest.
 *
 * @param root - the account's scope root.
 * @param target - the level actually listed.
 * @returns the crumb rows, root first.
 */
function scopedCrumbs(root, target) {
  const crumbs = [{ name: root, path: root, hidden: false }]
  if (!insideScope(root, target)) return crumbs
  let cursor = root
  for (const segment of target.slice(root.length).split(sep).filter((part) => part.length > 0)) {
    cursor = join(cursor, segment)
    crumbs.push({ name: segment, path: cursor, hidden: false })
  }
  return crumbs
}

/**
 * How long a cold `/rag/*` request may wait for the account's sidecar to bind.
 *
 * `supervisor.acquire()` resolves as soon as the *DSH instance* answers; the RAG
 * sidecar is a child process that instance spawns (the profile patch sets
 * `raganything-kb: autoStart: true`), so the port stays closed a while longer.
 * Measured on 192.168.8.6: ~10 s once the profile tree is warm, but 60 s+ the
 * very first time because the instance has to sync its node_modules first.
 * Forwarding immediately yields a bare `502 rag sidecar on port 32xxx
 * unreachable`, which the panel renders as "未连接（演示数据）".
 *
 * Waiting is always the right call once the instance has been started — giving
 * up early just throws away the boot we already paid for, and the user's retry
 * would wait again from zero. nginx allows 3600 s here, so the budget is ours
 * to spend; 120 s covers the cold-sync case with margin.
 */
const RAG_READY_TIMEOUT_MS = 120_000

/** How often the wait re-asserts that the instance is (still) alive. */
const RAG_READY_RECHECK_TICKS = 10

/** Probe one loopback TCP port: resolves true once it accepts a connection. */
function ragPortOpen(port) {
  return new Promise((resolve) => {
    let settled = false
    const socket = netConnect({ port, host: '127.0.0.1' })
    const done = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(1_000)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * Wait (bounded) for a freshly spawned sidecar to start accepting requests.
 *
 * `onTick` is re-invoked every `RAG_READY_RECHECK_TICKS` probes. The launcher
 * passes `supervisor.acquire(user)` there: the instance can die in the middle
 * of a boot (a port collision on 31000 is a real failure mode on this host),
 * and re-asserting is what turns a lost race into a slow request instead of a
 * two-minute wait for nothing. Errors are swallowed — the loop owns the budget.
 */
async function waitForRagPort(port, budgetMs, onTick) {
  const deadline = Date.now() + budgetMs
  let ticks = 0
  for (;;) {
    if (await ragPortOpen(port)) return true
    if (Date.now() >= deadline) return false
    if (onTick !== undefined && ++ticks % RAG_READY_RECHECK_TICKS === 0) {
      try {
        await onTick()
      } catch {
        // The instance may be mid-restart; keep probing until the deadline.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = `${JSON.stringify(body)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(payload)
}

function sendHtml(res, status, html, extraHeaders = {}) {
  const payload = Buffer.from(html, 'utf8')
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': payload.byteLength,
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(payload)
}

/**
 * A readable (non-HttpOnly) twin of the session cookie.
 *
 * Browser-side state — chat history, knowledge-base folders, index prefs — lives
 * in `localStorage`, which is scoped per ORIGIN. Every account shares one origin
 * behind the gateway, so the client needs the account name to namespace its
 * keys. This cookie carries nothing but the username and is never used for
 * authentication.
 */
function userCookie(username, expiresAt) {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  return `dsh_mu_user=${encodeURIComponent(username)}; Path=/; SameSite=Lax; Max-Age=${maxAge}; Expires=${new Date(expiresAt).toUTCString()}`
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { location, 'cache-control': 'no-store', ...headers })
  res.end()
}

/** Read a request body with a size cap. */
function readBody(req, limitBytes) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (limitBytes > 0 && size > limitBytes) {
        rejectPromise(new Error(`请求体超过上限 ${limitBytes} 字节`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectPromise)
  })
}

/**
 * Read a request body as raw bytes.
 *
 * An uploaded spreadsheet is not text and has no encodable JSON envelope, so the
 * upload endpoint takes the file as the request body itself (the browser sets
 * `content-type` from the File, which we ignore) and never has to parse
 * multipart/form-data.
 */
function readBodyBuffer(req, limitBytes) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (limitBytes > 0 && size > limitBytes) {
        rejectPromise(new Error(`上传文件超过上限 ${Math.round(limitBytes / 1024 / 1024)} MB`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks)))
    req.on('error', rejectPromise)
  })
}

/** Send a generated file as a download. */
function sendAttachment(res, status, payload, contentType, filename) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': payload.length,
    'cache-control': 'no-store',
    'content-disposition': `attachment; filename="${filename}"`,
  })
  res.end(payload)
}

/**
 * Parse a request body.
 *
 * `application/json` and form encoding are read as declared. `text/plain` is
 * accepted as a lenient fallback: `fetch(url, { body: JSON.stringify(x) })`
 * without an explicit content type is a very common client, and the body is
 * unambiguous enough to sniff.
 */
function parseBody(raw, contentType) {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase()
  if (type === 'application/json' || type === 'text/plain') {
    if (raw.trim().length === 0) return {}
    try {
      return JSON.parse(raw)
    } catch (error) {
      if (type === 'application/json') throw new Error(`请求体不是合法 JSON：${error.message}`)
    }
  }
  if (type === 'application/x-www-form-urlencoded' || type === 'text/plain' || type === '') {
    const out = {}
    for (const pair of raw.split('&')) {
      if (pair.length === 0) continue
      const at = pair.indexOf('=')
      const key = at === -1 ? pair : pair.slice(0, at)
      const value = at === -1 ? '' : pair.slice(at + 1)
      out[decodeURIComponent(key.replaceAll('+', ' '))] = decodeURIComponent(value.replaceAll('+', ' '))
    }
    return out
  }
  throw new Error(`不支持的 Content-Type: ${type}`)
}

/** The client address used for login throttling. */
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for']
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim()
    }
  }
  return req.socket?.remoteAddress ?? 'unknown'
}

/** Whether the caller is a browser navigation (wants a redirect, not a 401 body). */
function wantsHtml(req) {
  const accept = String(req.headers.accept ?? '')
  return accept.includes('text/html') || accept.includes('application/xhtml+xml')
}

/**
 * Create the gateway.
 * @param options - `{ config, store, sessions, supervisor, logger, hostInfo }`.
 */
export function createGateway(options) {
  const { config, store, sessions, supervisor, admin } = options
  const logger = options.logger ?? console
  const trustProxy = options.trustProxy === true
  const base = config.basePath
  const startedAt = Date.now()
  let server = null
  let boundPort = null

  /** Resolve the signed-in account for a request. Returns undefined when anonymous. */
  function currentUser(req) {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE)
    const session = sessions.resolve(token)
    if (session === undefined) return undefined
    const user = store.find(session.username)
    if (user === undefined || user.status !== 'active') {
      sessions.revoke(token)
      return undefined
    }
    return { user, token }
  }

  /** Route one gateway-owned path. Returns true when the request was handled. */
  async function handleOwnRoute(req, res, url) {
    const pathname = url.pathname
    const relative = pathname === base ? '/' : pathname.slice(base.length)
    const method = req.method ?? 'GET'

    if (relative === '/api/login' && method === 'POST') {
      return handleLogin(req, res, url)
    }
    if (relative === '/login' && method === 'GET') {
      return handleLoginPage(req, res, url)
    }
    if (relative === '/logout') {
      const session = readCookie(req.headers.cookie, SESSION_COOKIE)
      sessions.revoke(session)
      return redirect(res, `${base}/login`, { 'set-cookie': clearCookie() })
    }
    if (relative === '/api/logout' && method === 'POST') {
      sessions.revoke(readCookie(req.headers.cookie, SESSION_COOKIE))
      return sendJson(res, 200, { ok: true, logoutCookie: true })
    }

    const identity = currentUser(req)
    if (relative === '/api/me' && method === 'GET') {
      if (identity === undefined) return sendJson(res, 401, { error: 'unauthorized' })
      return sendJson(res, 200, {
        user: publicShape(identity.user),
        apps: admin.apps().apps,
        minPasswordLength: config.minPasswordLength,
      })
    }
    // Changing one's own password must be reachable by *every* signed-in
    // account, so it is routed before the administrator-only `/api/*` block.
    if (relative === '/api/password' && method === 'POST') {
      if (identity === undefined) return sendJson(res, 401, { error: 'unauthorized' })
      return handleSelfPassword(req, res, identity)
    }
    if (identity === undefined) {
      if (wantsHtml(req)) return redirect(res, `${base}/login?next=${encodeURIComponent(url.pathname)}`)
      return sendJson(res, 401, { error: 'unauthorized' })
    }

    // RAG-Anything: forward `/rag` reached inside a user space to that
    // account's OWN sidecar (same logic as the top-level `/rag` handler in
    // onRequest), instead of proxying it to the per-user DSH instance, which
    // does not expose `/rag` routes and would 404. Resolving the port from the
    // server-side session keeps accounts isolated and cannot be forged.
    if (relative === '/rag' || relative.startsWith('/rag/')) {
      return proxyRagSidecar(req, res, url, relative)
    }

    if ((relative === '/' || relative === '') && method === 'GET') {
      return redirect(res, identity.user.role === 'admin' ? `${base}/admin` : '/')
    }
    if (relative === '/admin' && method === 'GET') {
      if (identity.user.role !== 'admin') {
        return sendHtml(res, 403, accountPage({
          basePath: base,
          user: publicShape(identity.user),
          apps: admin.apps().apps,
          minPasswordLength: config.minPasswordLength,
        }))
      }
      return sendHtml(res, 200, adminPage({ basePath: base, username: identity.user.username }))
    }
    if (relative === '/account' && method === 'GET') {
      return sendHtml(res, 200, accountPage({
        basePath: base,
        user: publicShape(identity.user),
        apps: admin.apps().apps,
        minPasswordLength: config.minPasswordLength,
      }))
    }
    // An unambiguous "take me to my workspace" link. `${base}/` cannot be used
    // for this: it is role-aware and sends admins straight back to the console,
    // so an admin clicking "返回工作台" appeared to do nothing at all.
    if (relative === '/workspace' && method === 'GET') {
      return redirect(res, '/')
    }

    // ── admin REST API ──────────────────────────────────────────────────────
    if (relative.startsWith('/api/')) {
      if (identity.user.role !== 'admin') return sendJson(res, 403, { error: '需要管理员权限' })
      return handleAdminApi(req, res, identity, relative, url)
    }

    sendJson(res, 404, { error: `网关未处理的路径 ${pathname}` })
    return true
  }

  function publicShape(user) {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      note: user.note ?? '',
      homeMode: user.homeMode,
      homeDir: user.homeDir ?? null,
      workspaceDir: user.workspaceDir ?? null,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt ?? null,
    }
  }

  function handleLoginPage(req, res, url) {
    return sendHtml(res, 200, loginPage({
      basePath: base,
      next: url.searchParams.get('next') ?? '/',
      error: url.searchParams.get('error') ?? '',
      notice: url.searchParams.get('notice') ?? '',
      allowSelfRegister: config.allowSelfRegister,
    }))
  }

  async function handleLogin(req, res, url) {
    const ip = clientIp(req, trustProxy)
    const lock = sessions.isLocked(ip)
    if (lock.locked) {
      const minutes = Math.ceil(lock.remainingMs / 60000)
      return sendHtml(res, 429, loginPage({
        basePath: base,
        error: `登录失败次数过多，请在 ${minutes} 分钟后重试。`,
      }))
    }
    let body
    try {
      body = parseBody(await readBody(req, 64 * 1024), req.headers['content-type'])
    } catch (error) {
      return sendHtml(res, 400, loginPage({ basePath: base, error: `请求解析失败：${error.message}` }))
    }
    const username = String(body.username ?? '').trim()
    const password = String(body.password ?? '')
    const next = String(body.next ?? '/')
    const outcome = store.authenticate(username, password)
    if (outcome.error !== undefined) {
      sessions.recordFailure(ip)
      const message = outcome.error === 'disabled' ? '该账号已被禁用，请联系管理员。' : '用户名或密码不正确。'
      logger.warn?.(`dsh-multi-user: failed login for ${JSON.stringify(username)} from ${ip}`)
      return sendHtml(res, 401, loginPage({ basePath: base, error: message, next }))
    }
    sessions.recordSuccess(ip)
    const issued = sessions.issue(outcome.user.username, { ip, userAgent: req.headers['user-agent'] })
    await store.touchLogin(outcome.user.username)
    logger.info?.(`dsh-multi-user: ${outcome.user.username} signed in from ${ip}`)
    const target = outcome.user.role === 'admin' && (next === '/' || next === '')
      ? `${base}/admin`
      : (next.startsWith('/') && !next.startsWith('//') ? next : '/')
    return redirect(res, target, {
      'set-cookie': [
        sessionCookie(issued.token, issued.expiresAt),
        userCookie(outcome.user.username, issued.expiresAt),
      ],
    })
  }

  /**
   * Change the signed-in account's own password.
   *
   * Deliberately separate from the administrator path: that one kills every
   * session of the target account (correct when *someone else* resets a
   * password), whereas changing your own password should leave the tab you are
   * using signed in and only drop the other sessions.
   */
  async function handleSelfPassword(req, res, identity) {
    let body
    try {
      body = parseBody(await readBody(req, 16 * 1024), req.headers['content-type'])
    } catch (error) {
      return sendJson(res, 400, { error: `请求解析失败：${error.message}` })
    }
    const current = String(body.currentPassword ?? '')
    const next = String(body.newPassword ?? '')
    const confirm = body.confirmPassword === undefined ? next : String(body.confirmPassword)
    if (current.length === 0) return sendJson(res, 400, { error: '请输入当前密码。' })
    if (next.length < config.minPasswordLength) {
      return sendJson(res, 400, { error: `新密码至少需要 ${config.minPasswordLength} 位。` })
    }
    if (next !== confirm) return sendJson(res, 400, { error: '两次输入的新密码不一致。' })
    if (next === current) return sendJson(res, 400, { error: '新密码不能与当前密码相同。' })
    // Compared against the stored hash directly rather than through
    // `store.authenticate`: a mistyped *current* password is not a login
    // attempt and must not count towards the per-IP lockout.
    if (!verifyPassword(current, identity.user.passwordHash)) {
      logger.warn?.(`dsh-multi-user: ${identity.user.username} failed a self-service password check`)
      return sendJson(res, 403, { error: '当前密码不正确。' })
    }
    const outcome = await admin.update(identity.user.username, { password: next }, {
      actor: identity.user.username,
    })
    if (outcome.error !== undefined) return sendJson(res, 400, outcome)
    // `admin.update` has already revoked every session for this account — the
    // caller's included — so hand the caller a fresh token and stay signed in.
    const issued = sessions.issue(identity.user.username, {
      ip: clientIp(req, trustProxy),
      userAgent: req.headers['user-agent'],
    })
    logger.info?.(`dsh-multi-user: ${identity.user.username} changed its own password`)
    return sendJson(
      res,
      200,
      { ok: true, revokedSessions: outcome.revokedSessions ?? 0 },
      { 'set-cookie': sessionCookie(issued.token, issued.expiresAt) },
    )
  }

  /**
   * Hand the operator a ready-to-fill import template.
   *
   * `?format=csv` returns the same columns as UTF-8 CSV for people who would
   * rather fill it in a text editor or export it from another system.
   */
  function sendUserImportTemplate(res, url) {
    const stamp = new Date().toISOString().slice(0, 10)
    if ((url.searchParams.get('format') ?? 'xlsx').toLowerCase() === 'csv') {
      return sendAttachment(
        res,
        200,
        buildUserTemplateCsv(),
        'text/csv; charset=utf-8',
        `dsh-users-template-${stamp}.csv`,
      )
    }
    return sendAttachment(
      res,
      200,
      buildUserTemplate(),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      `dsh-users-template-${stamp}.xlsx`,
    )
  }

  /**
   * Import accounts from an uploaded workbook.
   *
   * The file is the request body; the import options travel as query parameters
   * so the endpoint needs neither multipart parsing nor a JSON envelope around
   * binary data. Parsing happens here (not in the browser) so the rules dictating
   * what counts as a valid roster are impossible to bypass from the client.
   */
  async function handleUserImportUpload(req, res, url, identity) {
    let buffer
    try {
      buffer = await readBodyBuffer(req, 16 * 1024 * 1024)
    } catch (error) {
      return sendJson(res, 413, { error: `读取上传文件失败：${error.message}` })
    }
    if (buffer.length === 0) return sendJson(res, 400, { error: '上传内容为空' })

    let table
    try {
      table = readUserTable(buffer, url.searchParams.get('filename') ?? '')
    } catch (error) {
      return sendJson(res, 400, { error: error.message })
    }
    if (table.records.length === 0) {
      return sendJson(res, 400, {
        error: '表格里没有可导入的账号：第 1 行应为表头（用户名 / 密码 / 角色 / 状态 / 备注），其后每行一个用户。',
      })
    }

    const result = await admin.import({
      rows: table.records,
      defaultRole: url.searchParams.get('defaultRole') ?? 'user',
      defaultStatus: url.searchParams.get('defaultStatus') ?? 'active',
      onExisting: url.searchParams.get('onExisting') ?? 'skip',
    })
    if (result.error !== undefined) return sendJson(res, 400, result)

    const source = {
      format: table.format,
      sheetName: table.sheetName,
      headerUsed: table.headerUsed,
      headers: table.headers,
      dataRows: table.records.length,
      ignoredRows: table.skippedRows,
      maxRows: MAX_IMPORT_ROWS,
    }

    // Every line rejected and nothing imported almost always means the wrong
    // file (a photo renamed `.csv`, a column layout we do not recognise). Say so
    // as a failure rather than reporting a cheerful "导入完成" of zero accounts.
    const summary = result.summary ?? {}
    if ((summary.created ?? 0) === 0 && (summary.updated ?? 0) === 0 && (summary.failed ?? 0) > 0) {
      return sendJson(res, 400, {
        ...result,
        source,
        error: `${table.records.length} 行全部无法导入，请检查文件内容是否为「用户名 / 密码 / 角色 / 状态 / 备注」这样的表格。`,
      })
    }

    logger.info?.(
      `dsh-multi-user: ${identity.user.username} imported ${table.records.length} row(s) from `
      + `${table.format}${table.sheetName === null ? '' : ` sheet "${table.sheetName}"`}`,
    )
    return sendJson(res, 200, { ...result, source })
  }

  async function handleAdminApi(req, res, identity, relative, url) {
    const method = req.method ?? 'GET'
    const route = relative.slice('/api/'.length).split('/').filter((part) => part.length > 0)
    // The spreadsheet endpoints carry their own body (a binary workbook or a
    // text export), so they are dispatched before the JSON body reader below
    // would reject them as "unsupported Content-Type".
    if (route[0] === 'users' && route[1] === 'import' && route[2] === 'template' && method === 'GET') {
      return sendUserImportTemplate(res, url)
    }
    if (route[0] === 'users' && route[1] === 'import' && route[2] === 'upload' && method === 'POST') {
      return handleUserImportUpload(req, res, url, identity)
    }
    let body = {}
    if (method !== 'GET' && method !== 'DELETE') {
      try {
        body = parseBody(await readBody(req, Math.max(config.maxBodyBytes, 8 * 1024 * 1024)), req.headers['content-type'])
      } catch (error) {
        return sendJson(res, 400, { error: `请求解析失败：${error.message}` })
      }
    }
    const segments = relative.slice('/api/'.length).split('/').filter((part) => part.length > 0)
    const [head, name, action] = segments

    if (head === 'users' && segments.length === 1 && method === 'GET') {
      return sendJson(res, 200, { users: admin.list() })
    }
    if (head === 'users' && segments.length === 1 && method === 'POST') {
      const outcome = await admin.create(body, identity.user.username)
      if (outcome.error !== undefined) return sendJson(res, 409, outcome)
      return sendJson(res, 201, outcome)
    }
    if (head === 'users' && name === 'import' && method === 'POST') {
      const result = await admin.import(body)
      if (result.error !== undefined) return sendJson(res, 400, result)
      return sendJson(res, 200, result)
    }
    if (head === 'users' && name !== undefined && action === undefined && method === 'PUT') {
      const outcome = await admin.update(name, body, { actor: identity.user.username })
      if (outcome.error !== undefined) return sendJson(res, 400, outcome)
      return sendJson(res, 200, outcome)
    }
    if (head === 'users' && name !== undefined && action === undefined && method === 'DELETE') {
      const outcome = await admin.remove(name, {
        actor: identity.user.username,
        forbidSelf: true,
        purge: url.searchParams.get('purge') === 'true',
      })
      if (outcome.error !== undefined) return sendJson(res, 400, outcome)
      return sendJson(res, 200, outcome)
    }
    if (head === 'users' && name !== undefined && action === 'password' && method === 'POST') {
      const outcome = await admin.update(name, { password: body.password ?? '' }, {
        actor: identity.user.username,
        rotatePassword: true,
      })
      if (outcome.error !== undefined) return sendJson(res, 400, outcome)
      return sendJson(res, 200, outcome)
    }
    if (head === 'status' && method === 'GET') {
      return sendJson(res, 200, admin.status({
        startedAt: new Date(startedAt).toISOString(),
        listenHost: config.listenHost,
        listenPort: boundPort ?? config.listenPort,
        basePath: base,
      }))
    }
    return sendJson(res, 404, { error: `未知的管理接口 ${relative}` })
  }

  /** Forward one authenticated request to the caller's own DSH instance. */
  /**
   * Reverse-proxy `/rag/*` to the signed-in account's OWN RAG sidecar.
   *
   * The knowledge-base panel is a browser bundle that can only reach the
   * public origin, so it fetches `<origin>/rag/*`. Routing that blindly at a
   * single shared sidecar (the historical 17321) made every account read one
   * shared knowledge base. The per-account port is `sidecarPortBase + slot` —
   * the exact formula the profile patch renders into each cordis.patch.yml —
   * so resolving it here from the *server-side session* keeps accounts apart
   * and cannot be forged from the browser.
   */
  /**
   * 后台预热本账号的知识库 sidecar（fire-and-forget、按账号去重）。
   *
   * 为什么需要它：`/rag/*` 现在按会话身份路由到账号自己的 sidecar（此前被
   * nginx 直连宿主 17321 —— 那正是"个人知识库串号"的根因）。但用户 sidecar 是
   * DSH 实例的子进程、懒加载，冷启动 10s（依赖已热）到 60s+（首次同步 profile
   * 依赖），而插件前端 `RAG_TIMEOUT_MS` 只有 20s —— 首个请求必然超时，面板显示
   * "未连接（演示数据）"，看起来像修复把知识库弄坏了。
   *
   * 所以在用户打开 DSH 页面时（页面请求走 onRequest 的 catch-all 分支）就点火，
   * 用户点进知识库时端口通常已经 bind。去重窗口 10 分钟，失败可重试。
   */
  const RAG_WARM_TTL_MS = 10 * 60 * 1000
  const ragWarm = new Map()

  function warmRagSidecar(user) {
    if (user === undefined || user.homeMode === 'host') return
    const previous = ragWarm.get(user.username)
    if (previous !== undefined && Date.now() - previous.at < RAG_WARM_TTL_MS) return
    ragWarm.set(user.username, { at: Date.now() })
    void (async () => {
      try {
        await supervisor.acquire(user)
        const fresh = store.find(user.username) ?? user
        const slot = Number.isInteger(fresh.slot) ? fresh.slot : 0
        const port = (config.sidecarPortBase ?? 32000) + slot
        const ready = await waitForRagPort(port, RAG_READY_TIMEOUT_MS, () => supervisor.acquire(user))
        if (ready) {
          logger.info?.(`dsh-multi-user: rag sidecar for ${user.username} warmed up on 127.0.0.1:${port}`)
        } else {
          logger.warn?.(`dsh-multi-user: rag sidecar warm-up for ${user.username} timed out on ${port}`)
          ragWarm.delete(user.username)
        }
      } catch (error) {
        logger.warn?.(`dsh-multi-user: rag sidecar warm-up for ${user.username} failed — ${error.message}`)
        ragWarm.delete(user.username)
      }
    })()
  }

  async function proxyRagSidecar(req, res, url, pathname) {
    const identity = currentUser(req)
    if (identity === undefined) return sendJson(res, 401, { error: 'unauthorized' })
    let user = identity.user
    // 「个人知识库」必须只呈现账号自己的资料，所以"复用宿主实例"只认
    // homeMode === 'host'。原先把 role === 'admin' 也并了进来：管控账号本身是
    // managed 实例（有自己的 sidecar），却被强行指向宿主实例，于是它的个人
    // 知识库直接读到宿主的知识库 —— 宿主私有文档、宿主 home 目录下的工作区
    // 文件、以及「共享/」命名空间全在里面，表现就是"个人知识库没有做用户
    // 隔离"。共享内容的统管能力由「共享知识库」分区提供，与个人库无关。
    const isHost = user.homeMode === 'host'
    let slot = Number.isInteger(user.slot) ? user.slot : null
    if (slot === null) {
      // Slot is claimed lazily when the instance first starts; force that so
      // the port is stable, then re-read the record.
      try {
        await supervisor.acquire(user)
        const fresh = store.find(user.username)
        if (fresh !== undefined) user = fresh
        slot = Number.isInteger(user.slot) ? user.slot : 0
      } catch {
        slot = 0
      }
    }
    const port = isHost ? 17321 : (config.sidecarPortBase ?? 32000) + slot
    if (!isHost) {
      // sidecar 是用户 DSH 实例的子进程：实例没起来时 /rag/* 只会回一个裸 502，
      // 面板显示"未连接（演示数据）"。acquire() 对已在运行的实例是廉价的（页面
      // 资源请求走的就是这条路径），顺手把实例拉起来，个人知识库才不会莫名空白。
      try {
        await supervisor.acquire(user)
      } catch (error) {
        logger.warn?.(
          `dsh-multi-user: rag sidecar instance for ${user.username} failed to start — ${error.message}`,
        )
      }
      // 实例就绪 ≠ sidecar 已 bind：它是实例的子进程（autoStart），冷账号还要
      // 再等 10s（依赖已热）到 60s+（首次要同步 profile 依赖）。不等就转发，
      // 首个 /rag/* 必然是 502，面板显示"未连接（演示数据）"。
      const ready = await waitForRagPort(port, RAG_READY_TIMEOUT_MS, () =>
        supervisor.acquire(user),
      )
      if (!ready) {
        logger.warn?.(
          `dsh-multi-user: rag sidecar for ${user.username} not listening on ${port} after ${RAG_READY_TIMEOUT_MS}ms — forwarding anyway`,
        )
      }
    }
    const target = pathname === '/rag' ? '/' : pathname.slice('/rag'.length)

    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase()
      if (HOP_BY_HOP.has(lower)) continue
      if (lower === 'cookie') continue
      if (lower === 'origin') continue
      headers[key] = value
    }
    headers.host = `127.0.0.1:${port}`

    const upstreamReq = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: req.method,
        path: target + (url.search ?? ''),
        headers,
      },
      (upstreamRes) => {
        const responseHeaders = {}
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          const lower = key.toLowerCase()
          if (HOP_BY_HOP.has(lower)) continue
          if (lower === 'set-cookie') continue
          responseHeaders[key] = value
        }
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders)
        upstreamRes.pipe(res)
      },
    )
    upstreamReq.on('error', (error) => {
      logger.warn?.(`dsh-multi-user: rag sidecar unreachable for ${user.username} at 127.0.0.1:${port} — ${error.message}`)
      if (!res.headersSent) sendJson(res, 502, { error: `rag sidecar on port ${port} unreachable` })
      else res.end()
    })
    if (config.proxyTimeoutMs > 0) {
      upstreamReq.setTimeout(config.proxyTimeoutMs, () => {
        upstreamReq.destroy(new Error(`RAG sidecar timed out (${config.proxyTimeoutMs}ms)`))
      })
    }
    req.pipe(upstreamReq)
  }

  /**
   * Judge one authenticated API request against the two things an ordinary
   * account may not do, before it reaches that account's instance.
   *
   * 1. Model configuration is the administrator's surface. Hiding 设置 → 模型
   *    removes the page; this closes the wire the page would have used, so a
   *    hand-rolled RPC cannot reach past the missing UI.
   * 2. The whole deployment tree is one Linux user's filesystem, so nothing at
   *    the OS level separates accounts and this gateway is the only boundary.
   *    Anything naming a path is therefore fenced to the account's own scope.
   *
   * Only a call that provably names the forbidden thing is refused; every other
   * RPC is forwarded untouched. The one exception is a scope-guarded path whose
   * body we cannot decode at all: a browser always sends JSON, so that is
   * treated as an attempt to slip past rather than as traffic to relay.
   *
   * @param req - the browser request; its body is consumed only when a fence
   *   applies, and handed back for forwarding otherwise.
   * @param user - the authenticated account record.
   * @returns `{ allowed: true, body?, fence? }`, or the refusal to answer with.
   */
  async function guardAccountRequest(req, user) {
    // The administrator owns the deployment and is fenced from nothing.
    if (isAdministrator(user)) return { allowed: true }
    const pathname = new URL(req.url ?? '/', 'http://gateway.invalid').pathname
    const wantsSettings = SETTINGS_WRITE_ENDPOINTS.has(pathname)
    const guardedConfig = wantsSettings || CREDENTIAL_WRITE_ENDPOINTS.has(pathname)
    const root = scopeRootOf(user)
    const guardedScope = root !== null && (
      PICKER_LIST_ENDPOINTS.has(pathname)
      || PICKER_CREATE_ENDPOINTS.has(pathname)
      || PICKER_NATIVE_ENDPOINTS.has(pathname)
      || WORKSPACE_CREATE_ENDPOINTS.has(pathname)
      || WORKSPACE_FILE_ENDPOINTS.has(pathname)
      || TERMINAL_ENDPOINTS.has(pathname)
    )
    if (!guardedConfig && !guardedScope) return { allowed: true }

    let raw
    try {
      raw = await readBodyBuffer(req, GUARDED_BODY_LIMIT)
    } catch (error) {
      return { allowed: false, status: 413, message: error.message }
    }
    let envelope
    try {
      envelope = JSON.parse(raw.toString('utf8'))
    } catch {
      if (!guardedScope) return { allowed: true, body: raw }
      return {
        allowed: false,
        code: 'gateway/bad-request',
        message: '请求体不是可解析的 RPC 信封，已按账号隔离策略拒绝。',
      }
    }
    const rpcId = typeof envelope?.rpcId === 'string' ? envelope.rpcId : undefined
    const rewrite = () => ({ allowed: true, body: Buffer.from(JSON.stringify(envelope), 'utf8') })
    const refuse = (message, code = 'gateway/forbidden') => ({ allowed: false, rpcId, code, message })

    if (guardedConfig) {
      const scope = configScopeOf(envelope, wantsSettings)
      if (rpcId !== undefined && scope !== undefined && isAdminOnlyConfigScope(scope)) {
        return refuse(`模型配置（${scope}）由管理员统一维护，普通账号可直接使用模型但不能修改它。`)
      }
      if (!guardedScope) return { allowed: true, body: raw }
    }

    const args = envelope?.payload?.args

    // The OS chooser hands back a path the gateway never sees, so it cannot be
    // fenced after the fact — it must not be offered at all.
    if (PICKER_NATIVE_ENDPOINTS.has(pathname)) {
      return refuse(`系统目录选择器不受账号范围限制，已禁用。请在应用内从「${root}」下选择目录。`)
    }

    if (PICKER_LIST_ENDPOINTS.has(pathname)) {
      // Being asked for a level the account does not own re-roots the request
      // instead of refusing it: the browser asks for the home directory (and
      // offers breadcrumbs above the root) on its own, and an error there would
      // read as a broken picker rather than as a boundary.
      const asked = namedArg(args, 'path', 0)
      if (typeof asked !== 'string' || asked.length === 0 || climbsOut(asked) || !insideScope(root, asked)) {
        setNamedArg(args, 'path', 0, root)
      }
      return { ...rewrite(), fence: { kind: 'picker', root } }
    }

    if (PICKER_CREATE_ENDPOINTS.has(pathname)) {
      const parent = namedArg(args, 'path', 0)
      if (climbsOut(parent) || !insideScope(root, parent)) {
        return refuse(`只能在账号自己的工作区内新建目录（当前范围：${root}）。`)
      }
      return rewrite()
    }

    if (WORKSPACE_CREATE_ENDPOINTS.has(pathname)) {
      // Registering a workspace is what pins a Session's working directory, so
      // this is the RPC the whole file/terminal fence ultimately rests on.
      const wanted = (Array.isArray(args) ? args[0] : args?.request)?.path
      if (climbsOut(wanted) || !insideScope(root, wanted)) {
        return refuse(`只能把工作区设在账号自己的范围内（${root}）。`)
      }
      return rewrite()
    }

    if (WORKSPACE_FILE_ENDPOINTS.has(pathname)) {
      const target = namedArg(args, 'path', 1)
      // A relative path is resolved upstream against the Session's workspace,
      // which the picker fence has already confined; only an escaping or
      // absolute one has to be judged here.
      if (climbsOut(target) || (isAbsolutePath(target) && !insideScope(root, target))) {
        return refuse(`“${target}”在账号的工作区范围之外，无法读取。`)
      }
      const relative = args !== null && !Array.isArray(args) ? args.relativePath : undefined
      if (climbsOut(relative)) {
        return refuse(`“${relative}”试图越出账号的工作区范围。`)
      }
      return rewrite()
    }

    // Administrator surface, whole family: reached only by a client that never
    // mounted the terminal plugin, i.e. by a hand-rolled request.
    if (TERMINAL_ENDPOINTS.has(pathname)) {
      return refuse('浏览器终端仅管理员可用；普通账号请让助手在会话内执行命令。')
    }

    return { allowed: true, body: raw }
  }

  /**
   * Rewrite one upstream RPC result so it describes the account's own scope.
   *
   * The instance answers with paths it can see, not paths the account may see.
   * A listing's breadcrumb and home anchors are re-rooted rather than refused,
   * because an error there would read as a broken picker rather than as a
   * boundary. The `cwd` branch is the original terminal guard: ordinary accounts
   * are refused the whole terminal family on the request side now, so it is a
   * fallback that only matters if that ever changes.
   *
   * @param body - the upstream response body.
   * @param fence - the verdict the request-side guard attached.
   * @returns the body to send on, unchanged when it is not a result we judge.
   */
  function fenceRpcResponse(body, fence) {
    let envelope
    try {
      envelope = JSON.parse(body.toString('utf8'))
    } catch {
      return body
    }
    const result = envelope?.result
    const value = result?.value
    if (result?.ok !== true || value === null || typeof value !== 'object') return body

    if (fence.kind === 'picker') {
      value.home = fence.root
      value.crumbs = scopedCrumbs(fence.root, value.path)
      return Buffer.from(JSON.stringify(envelope), 'utf8')
    }

    const cwd = typeof value.cwd === 'string' ? value.cwd : ''
    if (cwd.length > 0 && !insideScope(fence.root, cwd)) {
      return Buffer.from(JSON.stringify({
        type: typeof envelope.type === 'string' ? envelope.type : 'server-response',
        rpcId: envelope.rpcId,
        result: {
          ok: false,
          error: {
            code: 'gateway/forbidden',
            message: `此会话的工作区（${cwd}）在账号隔离范围之外，请先在自己的工作区内新建会话。`,
            details: {},
          },
        },
      }), 'utf8')
    }
    return body
  }

  /**
   * Answer one refused RPC in the Connection carrier's own failure shape.
   *
   * The client decodes `server-response` and nothing else: an HTTP 403 would
   * surface as "transport failure ... HTTP 403", blaming the network instead of
   * the permission, and the settings page would show it as an unreadable
   * snapshot rather than a refusal.
   */
  function sendRpcFailure(res, rpcId, code, message) {
    sendJson(res, 200, {
      type: 'server-response',
      rpcId,
      result: { ok: false, error: { code, message, details: {} } },
    })
  }

  async function proxy(req, res, user) {
    let upstream
    try {
      upstream = await supervisor.acquire(user)
    } catch (error) {
      logger.error?.(`dsh-multi-user: upstream unavailable for ${user.username}: ${error.message}`)
      if (wantsHtml(req)) {
        return sendHtml(res, 503, errorPage({
          title: '独立空间暂时不可用',
          detail: error.message,
          basePath: base,
        }))
      }
      return sendJson(res, 503, { error: error.message })
    }

    // 两道路防线都在这里收口：模型配置是管理员专属面（入口那一半由 profile
    // 完成——普通账号的插件行 `ui-settings-models` 被禁用，设置面板里没有
    // 「模型」），账号文件范围是隔离面（全部署同一个 Linux 用户，操作系统层面
    // 没有任何分界，网关是唯一的那道）。
    const guard = await guardAccountRequest(req, user)
    if (!guard.allowed) {
      logger.warn?.(
        `dsh-multi-user: refused request from ${user.username}`
        + ` (${guard.code ?? guard.status} ${req.url ?? ''})`,
      )
      if (guard.rpcId === undefined) return sendJson(res, guard.status ?? 403, { error: guard.message })
      return sendRpcFailure(res, guard.rpcId, guard.code, guard.message)
    }

    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase()
      if (HOP_BY_HOP.has(lower)) continue
      if (lower === 'cookie') continue
      // `origin` must travel with the authority we present upstream, not the
      // browser's. We rewrite Host to this instance's loopback authority to
      // satisfy its DNS-rebinding fence, and every API request then undergoes
      // an Origin fence requiring `Origin` be exactly that authority: a browser
      // fetch still carries the *public* origin (`https://<host>:3082`), so
      // forwarding it verbatim mismatches and the request is rejected with 403
      // before it ever reaches authentication — which is why XHR-driven panels
      // (model providers, agent presets) read "transport failure" while page
      // navigations and WebSocket upgrades, which carry no Origin after the
      // upgrade path strips it, work fine. Dropping the header here is the
      // same measure the WebSocket tunnel already applies; suppressing it is
      // not a security hole because the cross-site defense is independent —
      // `sec-fetch-site` is forwarded untouched and still trips upstream.
      if (lower === 'origin') continue
      headers[key] = value
    }
    headers.host = `127.0.0.1:${upstream.port}`
    if (upstream.cookie !== undefined) headers.cookie = upstream.cookie
    // Strip transport compression only for documents we may rewrite; assets
    // keep gzip so the proxied UI stays fast.
    if (wantsHtml(req) || guard.fence !== undefined) headers['accept-encoding'] = 'identity'
    // The body we inspect may also be the body we replaced, so its length is
    // ours to state — forwarding the original would desynchronise the upstream
    // read. Every case variant is dropped first so only one header survives.
    if (guard.body !== undefined) {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'content-length') delete headers[key]
      }
      headers['content-length'] = String(guard.body.length)
    }

    const options = {
      host: '127.0.0.1',
      port: upstream.port,
      method: req.method,
      path: req.url,
      headers,
    }

    const upstreamReq = httpRequest(options, (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502
      const responseHeaders = {}
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        const lower = key.toLowerCase()
        if (HOP_BY_HOP.has(lower)) continue
        // The upstream's browser-session cookie is authority-bound to loopback
        // and meaningless (and confusing) in the browser.
        if (lower === 'set-cookie') continue
        responseHeaders[key] = value
      }
      responseHeaders['cache-control'] = responseHeaders['cache-control'] ?? 'no-store'

      const contentType = String(upstreamRes.headers['content-type'] ?? '')
      const encoding = String(upstreamRes.headers['content-encoding'] ?? '')
      const wantsWidget = config.injectLogoutWidget
        && status === 200
        && contentType.includes('text/html')
        && encoding === ''
      const wantsFence = guard.fence !== undefined
        && status === 200
        && contentType.includes('json')
        && encoding === ''
      const rewritable = wantsWidget || wantsFence

      if (!rewritable) {
        res.writeHead(status, responseHeaders)
        upstreamRes.pipe(res)
        return
      }

      const chunks = []
      let size = 0
      let aborted = false
      upstreamRes.on('data', (chunk) => {
        size += chunk.length
        if (size > HTML_REWRITE_LIMIT) {
          // Too large to buffer: fall back to a straight pass-through. A fenced
          // answer cannot take that shortcut — relaying it unfenced is exactly
          // what the fence exists to prevent — so it fails closed instead.
          aborted = true
          delete responseHeaders['content-length']
          if (wantsFence) {
            logger.warn?.(`dsh-multi-user: fenced RPC answer for ${user.username} exceeded the buffer limit`)
            res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ error: '账号隔离：上游应答过大，已拒绝转发。' }))
            upstreamRes.destroy()
            return
          }
          res.writeHead(status, responseHeaders)
          res.write(Buffer.concat(chunks))
          upstreamRes.pipe(res)
          return
        }
        chunks.push(chunk)
      })
      upstreamRes.on('end', () => {
        if (aborted) return
        const raw = Buffer.concat(chunks)
        let payload
        if (wantsFence) {
          payload = fenceRpcResponse(raw, guard.fence)
        } else {
          let html = raw.toString('utf8')
          const widget = logoutWidget(base, user.username)
          html = html.includes('</body>')
            ? html.replace('</body>', `${widget}</body>`)
            : `${html}${widget}`
          payload = Buffer.from(html, 'utf8')
        }
        delete responseHeaders['content-length']
        res.writeHead(status, responseHeaders)
        res.end(payload)
      })
      upstreamRes.on('error', () => {
        if (!aborted) res.destroy()
      })
    })

    if (config.proxyTimeoutMs > 0) {
      upstreamReq.setTimeout(config.proxyTimeoutMs, () => {
        upstreamReq.destroy(new Error(`上游响应超时（${config.proxyTimeoutMs}ms）`))
      })
    }
    upstreamReq.on('error', (error) => {
      logger.warn?.(`dsh-multi-user: proxy error for ${user.username}: ${error.message}`)
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (wantsHtml(req)) {
        sendHtml(res, 502, errorPage({ title: '无法连接独立空间', detail: error.message, basePath: base }))
        return
      }
      sendJson(res, 502, { error: error.message })
    })
    // A guarded RPC's body was already read off the socket to be inspected;
    // hand it over as-is instead of piping a request that has no data left.
    if (guard.body === undefined) req.pipe(upstreamReq)
    else upstreamReq.end(guard.body)
  }

  /** Tunnel an authenticated WebSocket upgrade to the caller's instance. */
  function proxyUpgrade(req, socket, head, user) {
    supervisor.acquire(user).then((upstream) => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (const [key, value] of Object.entries(req.headers)) {
        const lower = key.toLowerCase()
        if (lower === 'cookie' || lower === 'host' || lower === 'origin') continue
        lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
      }
      lines.push(`host: 127.0.0.1:${upstream.port}`)
      if (upstream.cookie !== undefined) lines.push(`cookie: ${upstream.cookie}`)
      const raw = `${lines.join('\r\n')}\r\n\r\n`

      const target = netConnect(upstream.port, '127.0.0.1', () => {
        target.write(raw)
        if (head !== undefined && head.length > 0) target.write(head)
        socket.pipe(target)
        target.pipe(socket)
      })
      target.on('error', (error) => {
        logger.warn?.(`dsh-multi-user: upgrade proxy error for ${user.username}: ${error.message}`)
        socket.destroy()
      })
      socket.on('error', () => target.destroy())
      socket.on('close', () => target.destroy())
    }).catch((error) => {
      logger.warn?.(`dsh-multi-user: upgrade refused for ${user.username}: ${error.message}`)
      socket.destroy()
    })
  }

  async function onRequest(req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://gateway.invalid')
    } catch {
      res.writeHead(400)
      res.end('bad request')
      return
    }
    try {
      // Per-account RAG sidecar. This must be resolved from the server-side
      // session *before* the catch-all below: `/rag` is not under basePath, so
      // it would otherwise be proxied to the account's DSH instance (which has
      // no such route -> 404) or, historically, to one shared sidecar that let
      // every account read the same knowledge base.
      if (url.pathname === '/rag' || url.pathname.startsWith('/rag/')) {
        await proxyRagSidecar(req, res, url, url.pathname)
        return
      }
      if (url.pathname === base || url.pathname.startsWith(`${base}/`)) {
        await handleOwnRoute(req, res, url)
        return
      }
      const identity = currentUser(req)
      if (identity === undefined) {
        if (wantsHtml(req)) {
          const next = url.pathname === '/' ? '' : `?next=${encodeURIComponent(url.pathname)}`
          redirect(res, `${base}/login${next}`)
          return
        }
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      // 顺手为本账号后台预热知识库 sidecar（fire-and-forget，不阻塞本次响应）。
      // 它是用户 DSH 实例的子进程，冷启动要 10s（依赖已热）到 60s+（首次同步
      // profile 依赖），而插件的前端 fetch 20s 就 abort → 首次打开知识库面板会
      // 显示"未连接（演示数据）"。在这条页面请求路径上提前点火，等用户点进
      // 知识库时 sidecar 通常已经 bind。
      warmRagSidecar(identity.user)
      await proxy(req, res, identity.user)
    } catch (error) {
      logger.error?.(`dsh-multi-user: request failed: ${error.stack ?? error.message}`)
      if (!res.headersSent) {
        if (wantsHtml(req)) sendHtml(res, 500, errorPage({ title: '网关内部错误', detail: error.message, basePath: base }))
        else sendJson(res, 500, { error: error.message })
      } else {
        res.destroy()
      }
    }
  }

  const api = {
    /** Bind the gateway. Rejects when the port is taken (FAILED fiber). */
    async listen() {
      server = createServer((req, res) => {
        void onRequest(req, res)
      })
      server.on('upgrade', (req, socket, head) => {
        try {
          const url = new URL(req.url ?? '/', 'http://gateway.invalid')
          if (url.pathname === base || url.pathname.startsWith(`${base}/`)) {
            socket.destroy()
            return
          }
        } catch {
          socket.destroy()
          return
        }
        const identity = currentUser(req)
        if (identity === undefined) {
          socket.destroy()
          return
        }
        proxyUpgrade(req, socket, head, identity.user)
      })
      server.keepAliveTimeout = 65_000
      server.headersTimeout = 70_000

      await new Promise((resolvePromise, rejectPromise) => {
        const onError = (error) => {
          if (error.code === 'EADDRINUSE') {
            rejectPromise(new Error(
              `dsh-multi-user: port ${config.listenPort} on ${config.listenHost} is already in use — `
              + 'set a different listenPort in the profile patch.',
            ))
            return
          }
          rejectPromise(error)
        }
        server.once('error', onError)
        server.listen(config.listenPort, config.listenHost, () => {
          server.off('error', onError)
          server.on('error', (error) => logger.error?.(`dsh-multi-user: gateway server error: ${error.message}`))
          const address = server.address()
          boundPort = typeof address === 'object' && address !== null ? address.port : config.listenPort
          resolvePromise(boundPort)
        })
      })
      return boundPort
    },

    /** Whether the gateway is accepting connections. */
    get port() {
      return boundPort
    },

    /** Stop accepting connections and drop them. */
    async close() {
      if (server === null) return
      const closing = server
      server = null
      await new Promise((resolvePromise) => {
        closing.close(() => resolvePromise())
        closing.closeAllConnections?.()
      })
    },

    /** Exposed for the host tools and diagnostics. */
    startingPageFor(username) {
      return startingPage({ basePath: base, username })
    },
    escape: escapeHtml,
  }

  return api
}
