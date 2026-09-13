/**
 * dsh-multi-user — a multi-user management gateway for DeepSeek Harness.
 *
 * WHAT IT ADDS
 *   One public port in front of a DSH installation, with:
 *   - a login gate (server-side sessions, scrypt passwords, per-IP throttling);
 *   - an administrator console for create/list/update/delete plus bulk import;
 *   - per-user spaces that are independent *structurally*: every account is
 *     served by its own `dsh web` process with its own `$DSH_HOME`, so
 *     sessions, credentials, settings, profiles and workspaces are physically
 *     separate directories. Nothing has to be filtered out of a response,
 *     because another account's data is not in it.
 *
 * WHERE IT CAN BE INSTALLED
 *   Any DSH host. The plugin has no npm dependencies, no build step and no
 *   absolute paths baked in: install it into a profile with
 *   `dsh plugin --profile <name> add <tgz>` and it boots on the next restart.
 *
 * @module dsh-multi-user
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAdmin } from './admin.js'
import { resolveConfig, hostDshHome } from './config.js'
import { createGateway } from './gateway.js'
import { createSessionManager } from './sessions.js'
import { createStore, generatePassword } from './store.js'
import { createSupervisor } from './supervisor.js'
import { createTools } from './tools.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-multi-user'

/**
 * Services this plugin waits for. `webServer` is what tells us the host DSH
 * instance's loopback port, which is the upstream for `adminHomeMode: 'host'`.
 */
export const inject = ['webServer']

/** Minimal structured logger that prefixes every line. */
function makeLogger(base) {
  const write = (level, message) => {
    const text = `dsh-multi-user: ${message}`
    if (level === 'error') base.error?.(text)
    else if (level === 'warn') base.warn?.(text)
    else base.info?.(text)
  }
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  }
}

/**
 * Plugin entry.
 * @param ctx - cordis host context.
 * @param rawConfig - the insert row's `config` object.
 */
export async function apply(ctx, rawConfig = {}) {
  // A per-user instance is a plain DSH that must not mount this gateway again.
  if (process.env.DSH_MU_DISABLED === '1') return

  const logger = makeLogger(ctx.logger ?? console)
  let config
  try {
    config = resolveConfig(rawConfig)
  } catch (error) {
    logger.error(`configuration rejected: ${error.message}`)
    return
  }
  if (!config.enabled) {
    logger.info('disabled by configuration (enabled: false)')
    return
  }

  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  mkdirSync(config.usersDir, { recursive: true, mode: 0o700 })
  mkdirSync(config.logDir, { recursive: true, mode: 0o700 })

  const store = createStore(config, logger)
  const sessions = createSessionManager(config, logger)

  /** The host instance's loopback port — resolved lazily; it is set after bind. */
  let hostPortCache = 0
  function hostPort() {
    const live = ctx.get('webServer')?.port
    if (Number.isInteger(live) && live > 0) {
      hostPortCache = live
      return live
    }
    return hostPortCache
  }

  /** Sign in to the host instance once and hold its cookie. */
  let hostCookieCache
  async function hostCookie() {
    if (hostCookieCache !== undefined) return hostCookieCache
    const port = hostPort()
    const token = process.env[config.hostTokenEnv ?? 'DSH_WEB_TOKEN']
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error('宿主 DSH 端口尚未就绪，请稍后重试。')
    }
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error(
        'adminHomeMode 为 "host"，但宿主 DSH 进程没有 DSH_WEB_TOKEN，网关无法代替管理员登录宿主实例。'
        + '请在 DSH 服务/启动脚本中设置 DSH_WEB_TOKEN（任意长随机串）后重启，'
        + '或把配置改为 adminHomeMode: managed（管理员也会获得一个独立实例）。',
      )
    }
    const { request } = await import('node:http')
    hostCookieCache = await new Promise((resolvePromise, rejectPromise) => {
      const req = request({
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: `/?token=${encodeURIComponent(token)}`,
        headers: { host: `127.0.0.1:${port}`, accept: 'text/html' },
      }, (res) => {
        res.resume()
        const raw = res.headers['set-cookie']
        const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
        const auth = list.find((entry) => entry.startsWith('dsh-auth-'))
        if (auth === undefined) {
          rejectPromise(new Error(
            `网关登录宿主 DSH 失败（HTTP ${res.statusCode}）：DSH_WEB_TOKEN 与宿主进程不一致。`,
          ))
          return
        }
        resolvePromise(auth.split(';')[0])
      })
      req.setTimeout(5000, () => req.destroy(new Error('宿主 token 交换超时')))
      req.on('error', (error) => rejectPromise(error))
      req.end()
    })
    return hostCookieCache
  }

  const supervisor = createSupervisor(config, {
    logger,
    hostPort,
    hostCookie,
    hostHome: () => hostDshHome(),
    persistPaths: (username, patch) => {
      void store.update(username, patch).catch(() => undefined)
    },
    /** Hand out the stable per-account ordinal inherited plugins key off. */
    claimSlot: async (username) => {
      const used = new Set(
        store
          .snapshot()
          .users.map((entry) => entry.slot)
          .filter((value) => Number.isInteger(value)),
      )
      // Smallest free ordinal, never max()+1: a lost write or a rolled-back
      // file must not let two accounts claim the same slot. They would derive
      // the same sidecar port and therefore share one knowledge base.
      let slot = 0
      while (used.has(slot)) slot += 1
      await store.update(username, { slot })
      return slot
    },
  })

  const admin = createAdmin({ config, store, sessions, supervisor, logger })

  const gateway = createGateway({
    config,
    store,
    sessions,
    supervisor,
    admin,
    logger,
    trustProxy: config.trustProxy,
  })

  // ── first-run bootstrap ────────────────────────────────────────────────────
  if (store.count() === 0 && config.bootstrapAdmin) {
    const username = config.bootstrapAdminUsername
    const password = config.bootstrapAdminPassword ?? generatePassword(16)
    let created
    try {
      created = await admin.create({ username, password, role: 'admin', status: 'active', note: '首次安装自动创建' }, 'bootstrap')
    } catch (error) {
      created = { error: error.message }
    }
    if (created.error === undefined) {
      const notice = [
        'DSH 多用户网关 — 初始管理员账号',
        '',
        `  用户名: ${username}`,
        `  密码:   ${password}`,
        '',
        `  管理控制台: http://<本机IP>:${config.listenPort}${config.basePath}/admin`,
        `  生成时间:   ${new Date().toISOString()}`,
        '',
        '请登录后立即修改密码，并删除本文件。',
        '',
      ].join('\n')
      try {
        const noticePath = join(config.dataDir, 'INITIAL_ADMIN.txt')
        writeFileSync(noticePath, notice, { mode: 0o600 })
        chmodSync(noticePath, 0o600)
      } catch {
        // The credential is still reported on the log line below.
      }
      logger.warn(`bootstrap administrator "${username}" created. Password: ${password}`)
      logger.warn(`the same notice was written to ${join(config.dataDir, 'INITIAL_ADMIN.txt')} (mode 0600) — delete it after your first sign-in`)
    } else {
      logger.warn(`bootstrap administrator not created: ${created.error}`)
    }
  }

  // ── start the gateway ─────────────────────────────────────────────────────
  const banner = () => {
    const shown = config.listenHost === '0.0.0.0' ? '<本机IP>' : config.listenHost
    logger.info(`gateway listening on ${config.listenHost}:${gateway.port ?? config.listenPort}`)
    logger.info(`  login page      http://${shown}:${gateway.port ?? config.listenPort}${config.basePath}/login`)
    logger.info(`  admin console   http://${shown}:${gateway.port ?? config.listenPort}${config.basePath}/admin`)
    logger.info(`  data directory  ${config.dataDir}`)
    logger.info(`  admin space     ${config.adminHomeMode === 'host' ? `host instance (port ${hostPort() || 'pending'})` : 'managed instance'}`)
  }

  gateway.listen().then(() => {
    banner()
    if (config.adminHomeMode === 'host' && !process.env.DSH_WEB_TOKEN) {
      logger.error(
        'DSH_WEB_TOKEN is not set on this DSH process, so adminHomeMode "host" cannot work. '
        + 'Set it in the DSH service environment and restart, or switch to adminHomeMode: managed.',
      )
    }
  }).catch((error) => {
    logger.error(`gateway failed to start: ${error.message}`)
    logger.error(`fix the listenPort/listenHost configuration and restart; the DSH UI itself is unaffected`)
  })

  // ── model-facing tools ────────────────────────────────────────────────────
  ctx.inject(['tools'], (toolsCtx) => {
    for (const tool of createTools({
      admin,
      config,
      supervisor,
      gatewayListen: `${config.listenHost}:${config.listenPort}`,
    })) {
      toolsCtx.effect(() => toolsCtx.tools.register(tool), `dsh-multi-user: ${tool.name}`)
    }
  })

  // ── orientation for the model ─────────────────────────────────────────────
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    ctx.effect(
      () => systemPrompt.section({
        name: 'multi-user',
        order: 2960,
        text:
          '本 DSH 部署挂载了多用户网关（dsh-multi-user）：mu_users_list / mu_user_create / '
          + 'mu_user_update / mu_user_delete / mu_users_import 用于管理账号，mu_gateway_status 用于诊断。'
          + `每个账号拥有完全独立的 DSH 空间（独立会话、凭据、工作区，数据目录 ${config.dataDir}）。`
          + '用户提到「加个用户 / 批量开账号 / 重置某人的密码 / 谁在用系统」时使用这些工具。',
      }),
      'dsh-multi-user: prompt section',
    )
  }

  // ── teardown ──────────────────────────────────────────────────────────────
  ctx.effect(() => () => {
    void gateway.close()
    void supervisor.stopAll()
  }, 'dsh-multi-user: gateway owner')

  // Diagnostics for a human looking at the running process.
  process.env.DSH_MU_GATEWAY_PORT = String(config.listenPort)
}

export { resolveConfig, hostDshHome } from './config.js'
export { createStore, hashPassword, verifyPassword, generatePassword } from './store.js'
export { createSessionManager, SESSION_COOKIE } from './sessions.js'
export { createSupervisor } from './supervisor.js'
export { createAdmin } from './admin.js'
export { createGateway } from './gateway.js'
