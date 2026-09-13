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
import {
  SESSION_COOKIE,
  clearCookie,
  readCookie,
  sessionCookie,
} from './sessions.js'
import { verifyPassword } from './store.js'
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
  async function proxyRagSidecar(req, res, url, pathname) {
    const identity = currentUser(req)
    if (identity === undefined) return sendJson(res, 401, { error: 'unauthorized' })
    let user = identity.user
    const isHost = user.homeMode === 'host' || user.role === 'admin'
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
    if (wantsHtml(req)) headers['accept-encoding'] = 'identity'

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
      const rewritable = config.injectLogoutWidget
        && status === 200
        && contentType.includes('text/html')
        && encoding === ''

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
          // Too large to buffer: fall back to a straight pass-through.
          aborted = true
          delete responseHeaders['content-length']
          res.writeHead(status, responseHeaders)
          res.write(Buffer.concat(chunks))
          upstreamRes.pipe(res)
          return
        }
        chunks.push(chunk)
      })
      upstreamRes.on('end', () => {
        if (aborted) return
        let html = Buffer.concat(chunks).toString('utf8')
        const widget = logoutWidget(base, user.username)
        html = html.includes('</body>')
          ? html.replace('</body>', `${widget}</body>`)
          : `${html}${widget}`
        const payload = Buffer.from(html, 'utf8')
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
    req.pipe(upstreamReq)
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
