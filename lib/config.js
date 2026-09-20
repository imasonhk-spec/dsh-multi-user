/**
 * dsh-multi-user — configuration resolution.
 *
 * Every knob has a safe default so the plugin boots with an empty `config:`
 * block. Values are read from the cordis row config, then from `DSH_MU_*`
 * environment variables, then from the built-in defaults.
 *
 * @module dsh-multi-user/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Environment variable prefix for every override. */
const ENV_PREFIX = 'DSH_MU_'

/** Built-in defaults; the cordis row config overrides any of them. */
export const DEFAULTS = {
  /** Master switch. `false` boots the plugin as a no-op (useful while debugging). */
  enabled: true,
  /** Gateway bind host. `0.0.0.0` exposes it on the network; `127.0.0.1` keeps it local (front it with nginx). */
  listenHost: '0.0.0.0',
  /** Gateway bind port. Must differ from the DSH web port. */
  listenPort: 3090,
  /** URL prefix owned by the gateway: login page, admin console, REST API. */
  basePath: '/mu',
  /** Absolute data directory; defaults to `<DSH_HOME>/multi-user`. */
  dataDir: null,
  /** DSH installation root used to spawn per-user instances; defaults to the host process cwd. */
  dshRoot: null,
  /** Executable that runs `dsh`; defaults to `pnpm` (falls back to `npx dsh`). */
  dshBin: null,
  /** Extra argv inserted before `web`, e.g. `["--profile","web"]` when dshBin is a bare node entrypoint. */
  dshArgs: [],
  /** Where the ADMIN's own space lives.
   *  - `host`    (default) the admin keeps using the DSH instance that runs this
   *              plugin, so existing sessions/workspace survive installation.
   *              Requires $DSH_WEB_TOKEN to be set for that instance.
   *  - `managed` the admin gets a spawned instance like everybody else.
   */
  adminHomeMode: 'host',
  /** Environment variable holding the host DSH instance's launch token. */
  hostTokenEnv: 'DSH_WEB_TOKEN',
  /** First port tried when allocating a port for a per-user instance. */
  portBase: 31000,
  /** How many consecutive ports are probed before falling back to an OS-assigned port. */
  portScanRange: 200,
  /** Login session lifetime, hours. */
  sessionTtlHours: 24,
  /** Remaining lifetime (hours) below which a used session is renewed to a full
   *  TTL on its next request. `0` disables sliding renewal. */
  sessionRenewThresholdHours: 6,
  /** Idle minutes after which a spawned per-user instance is stopped. `0` disables reaping. */
  idleTimeoutMinutes: 30,
  /** Seconds to wait for a freshly spawned DSH instance to answer before giving up. */
  startTimeoutSeconds: 120,
  /** Per-request timeout (ms) for gateway -> DSH instance proxying. `0` disables. */
  proxyTimeoutMs: 0,
  /** Copy the host's model credentials into a newly created user's home so it works immediately. */
  seedOnCreate: true,
  /** Files/dirs copied from the host DSH home into a new user's home. */
  seedFiles: ['.credentials.yaml', '.env', 'settings.yaml', '.agent-presets'],
  /**
   * Mirror the host profile's *application set* into every managed user's home.
   *
   * A per-user instance has its own `$DSH_HOME`, so a plugin installed for the
   * host is invisible inside an account until its profile is mirrored too. On:
   * an app installed once on the host (a knowledge base, a tool bundle) shows up
   * in every account without installing it per user.
   */
  inheritProfile: true,
  /** Profile whose applications are inherited; defaults to `$DSH_PROFILE`, then `web`. */
  profile: null,
  /**
   * Re-check the inherited application set whenever a user instance is used,
   * and restart that instance when the host's set has changed. This is what
   * makes "admin installs a plugin → users get it on their next page load" work.
   */
  syncProfileOnStart: true,
  /**
   * Mirror the administrator's model catalogue (`llm-pi-ai:`) into every other
   * account's `settings.yaml`, so an account only ever picks from the models the
   * administrator published instead of the ones it happened to be seeded with.
   * The account's own `agent-default-model` choice is left alone. Setting this
   * to `false` freezes each account at whatever it was seeded with.
   */
  inheritAdminModels: true,
  /**
   * Minimum milliseconds between two host-application-set checks. The check
   * itself only hashes a handful of small files, but this keeps a busy gateway
   * from touching the disk on every single proxied request. `0` checks always.
   */
  appSyncIntervalMs: 2000,
  /** Shortest password the self-service form will accept. */
  minPasswordLength: 8,
  /**
   * Base port for `{sidecarPort}` in `userProfilePatch`.
   *
   * Some inherited plugins start a helper process on a FIXED port and then
   * *adopt* whatever already answers there. On a multi-account host that makes
   * every account share the host's process — and its data. Giving each account
   * its own port is what turns "the app is visible" into "the app is private".
   * The port is `sidecarPortBase + slot`.
   */
  sidecarPortBase: 32000,
  /**
   * YAML appended to every user profile's `cordis.patch.yml`, letting an
   * administrator make an inherited application per-account without teaching
   * this plugin about any particular application.
   *
   * Placeholders: `{username}` `{home}` `{workspace}` `{port}` `{slot}`
   * `{sidecarPort}`. Example that gives each account its own knowledge base:
   *
   *   userProfilePatch: |-
   *     - id: raganything-kb
   *       config:
   *         ragHome: '{home}/raganything'
   *         sidecarPort: {sidecarPort}
   */
  userProfilePatch: '',
  /**
   * Symlinks created inside every user home, as `{ '<user-relative path>':
   * '<host absolute path>' }`. Use it to share read-only bulk (model files, a
   * Python venv) that each account needs but should not duplicate.
   */
  userSeedLinks: {},
  /** Create a bootstrap administrator automatically when the user store is empty. */
  bootstrapAdmin: true,
  /** Username of the bootstrap administrator. */
  bootstrapAdminUsername: 'admin',
  /** Password of the bootstrap administrator; `null` generates a strong random one. */
  bootstrapAdminPassword: null,
  /** Allow unauthenticated visitors to register themselves (invite-free signup). */
  allowSelfRegister: false,
  /** Login failures per IP inside the window before the IP is locked out. */
  loginMaxFailures: 5,
  /** Login lockout window, minutes. */
  loginLockMinutes: 10,
  /** Reverse-proxy request bodies up to this size, bytes. `0` = unlimited. */
  maxBodyBytes: 0,
  /**
   * Trust `X-Forwarded-For` when attributing login attempts. Turn this on only
   * when the gateway sits behind a reverse proxy you control — with the gateway
   * exposed directly, a client could spoof the header to dodge throttling.
   */
  trustProxy: false,
  /** Inject a small floating "signed in as / sign out" widget into proxied HTML pages. */
  injectLogoutWidget: true,
}

/** Coerce a plain-object map (yaml), tolerating a JSON string form from env. */
function coerceMap(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'object' && !Array.isArray(value)) return { ...value }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // not JSON — fall through to the default
    }
  }
  return fallback
}

/** Coerce a value that may arrive as a string (env) or its native type (yaml). */
function coerceBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  return /^(1|true|yes|on)$/i.test(String(value).trim())
}

function coerceNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function coerceString(value, fallback) {
  if (value === undefined || value === null) return fallback
  const text = String(value)
  return text.length === 0 ? fallback : text
}

function coerceArray(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (Array.isArray(value)) return value.map(String).filter((item) => item.length > 0)
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

/** Read one knob from the row config, then the environment, then the default. */
function pick(raw, env, key, coerce) {
  const fromConfig = raw[key]
  if (fromConfig !== undefined && fromConfig !== null) return coerce(fromConfig, DEFAULTS[key])
  const envKey = ENV_PREFIX + key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()
  if (env[envKey] !== undefined) return coerce(env[envKey], DEFAULTS[key])
  return DEFAULTS[key]
}

/** Normalize a base path to `/segment` with no trailing slash. */
function normalizeBasePath(value) {
  let text = coerceString(value, DEFAULTS.basePath).trim()
  if (!text.startsWith('/')) text = `/${text}`
  while (text.length > 1 && text.endsWith('/')) text = text.slice(0, -1)
  return text
}

/** The DSH harness home this plugin's own process is reading. */
export function hostDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

/**
 * Resolve the effective plugin configuration.
 * @param raw - the cordis row `config` object (may be undefined).
 * @param options - `{ env, cwd }` seams for tests.
 * @returns a frozen, normalized configuration object.
 */
export function resolveConfig(raw = {}, options = {}) {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const config = {}
  config.enabled = pick(raw, env, 'enabled', coerceBoolean)
  config.listenHost = coerceString(pick(raw, env, 'listenHost', coerceString), DEFAULTS.listenHost)
  config.listenPort = coerceNumber(pick(raw, env, 'listenPort', coerceNumber), DEFAULTS.listenPort)
  config.basePath = normalizeBasePath(pick(raw, env, 'basePath', coerceString))
  config.dataDir = resolve(coerceString(pick(raw, env, 'dataDir', coerceString), join(hostDshHome(env), 'multi-user')))
  config.dshRoot = pick(raw, env, 'dshRoot', coerceString)
  config.dshRoot = config.dshRoot === null ? cwd : resolve(config.dshRoot)
  config.dshBin = pick(raw, env, 'dshBin', coerceString)
  config.dshArgs = coerceArray(pick(raw, env, 'dshArgs', coerceArray), DEFAULTS.dshArgs)
  config.adminHomeMode = pick(raw, env, 'adminHomeMode', coerceString)
  if (config.adminHomeMode !== 'host' && config.adminHomeMode !== 'managed') {
    throw new Error(`dsh-multi-user: adminHomeMode must be "host" or "managed", got ${JSON.stringify(config.adminHomeMode)}`)
  }
  config.portBase = coerceNumber(pick(raw, env, 'portBase', coerceNumber), DEFAULTS.portBase)
  config.hostTokenEnv = coerceString(pick(raw, env, 'hostTokenEnv', coerceString), DEFAULTS.hostTokenEnv)
  config.portScanRange = coerceNumber(pick(raw, env, 'portScanRange', coerceNumber), DEFAULTS.portScanRange)
  config.sessionTtlHours = coerceNumber(pick(raw, env, 'sessionTtlHours', coerceNumber), DEFAULTS.sessionTtlHours)
  config.sessionRenewThresholdHours = coerceNumber(pick(raw, env, 'sessionRenewThresholdHours', coerceNumber), DEFAULTS.sessionRenewThresholdHours)
  config.idleTimeoutMinutes = coerceNumber(pick(raw, env, 'idleTimeoutMinutes', coerceNumber), DEFAULTS.idleTimeoutMinutes)
  config.startTimeoutSeconds = coerceNumber(pick(raw, env, 'startTimeoutSeconds', coerceNumber), DEFAULTS.startTimeoutSeconds)
  config.proxyTimeoutMs = coerceNumber(pick(raw, env, 'proxyTimeoutMs', coerceNumber), DEFAULTS.proxyTimeoutMs)
  config.seedOnCreate = pick(raw, env, 'seedOnCreate', coerceBoolean)
  config.seedFiles = coerceArray(pick(raw, env, 'seedFiles', coerceArray), DEFAULTS.seedFiles)
  config.inheritProfile = pick(raw, env, 'inheritProfile', coerceBoolean)
  // `$DSH_PROFILE` (unprefixed) is the harness's own knob, so honour it before
  // falling back to the conventional "web" profile name.
  config.profile = coerceString(pick(raw, env, 'profile', coerceString) ?? env.DSH_PROFILE, 'web')
  config.syncProfileOnStart = pick(raw, env, 'syncProfileOnStart', coerceBoolean)
  config.inheritAdminModels = pick(raw, env, 'inheritAdminModels', coerceBoolean)
  config.appSyncIntervalMs = coerceNumber(pick(raw, env, 'appSyncIntervalMs', coerceNumber), DEFAULTS.appSyncIntervalMs)
  config.minPasswordLength = coerceNumber(pick(raw, env, 'minPasswordLength', coerceNumber), DEFAULTS.minPasswordLength)
  config.sidecarPortBase = coerceNumber(pick(raw, env, 'sidecarPortBase', coerceNumber), DEFAULTS.sidecarPortBase)
  config.userProfilePatch = coerceString(pick(raw, env, 'userProfilePatch', coerceString), '')
  config.userSeedLinks = coerceMap(pick(raw, env, 'userSeedLinks', coerceMap), DEFAULTS.userSeedLinks)
  config.bootstrapAdmin = pick(raw, env, 'bootstrapAdmin', coerceBoolean)
  config.bootstrapAdminUsername = coerceString(pick(raw, env, 'bootstrapAdminUsername', coerceString), DEFAULTS.bootstrapAdminUsername)
  config.bootstrapAdminPassword = pick(raw, env, 'bootstrapAdminPassword', coerceString)
  config.allowSelfRegister = pick(raw, env, 'allowSelfRegister', coerceBoolean)
  config.loginMaxFailures = coerceNumber(pick(raw, env, 'loginMaxFailures', coerceNumber), DEFAULTS.loginMaxFailures)
  config.loginLockMinutes = coerceNumber(pick(raw, env, 'loginLockMinutes', coerceNumber), DEFAULTS.loginLockMinutes)
  config.maxBodyBytes = coerceNumber(pick(raw, env, 'maxBodyBytes', coerceNumber), DEFAULTS.maxBodyBytes)
  config.trustProxy = pick(raw, env, 'trustProxy', coerceBoolean)
  config.injectLogoutWidget = pick(raw, env, 'injectLogoutWidget', coerceBoolean)

  // `0` is legitimate: it asks the OS for a free port, which the banner reports.
  if (!Number.isInteger(config.listenPort) || config.listenPort < 0 || config.listenPort > 65535) {
    throw new Error(`dsh-multi-user: listenPort must be a port number (0 = OS-assigned), got ${JSON.stringify(config.listenPort)}`)
  }
  if (!Number.isInteger(config.portBase) || config.portBase < 1024 || config.portBase > 65535 - config.portScanRange) {
    throw new Error(`dsh-multi-user: portBase must be between 1024 and ${65535 - config.portScanRange}`)
  }
  if (!isAbsolute(config.dataDir)) {
    throw new Error(`dsh-multi-user: dataDir must be absolute, got ${JSON.stringify(config.dataDir)}`)
  }
  // The profile name becomes a path segment under every user home — keep it a name.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.profile)) {
    throw new Error(`dsh-multi-user: profile must be a profile name, got ${JSON.stringify(config.profile)}`)
  }
  config.usersDir = join(config.dataDir, 'users')
  config.usersFile = join(config.dataDir, 'users.json')
  config.sessionsFile = join(config.dataDir, 'sessions.json')
  config.logDir = join(config.dataDir, 'logs')
  return Object.freeze(config)
}
