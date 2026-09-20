/**
 * dsh-multi-user — durable user store.
 *
 * One JSON document under `<dataDir>/users.json` holding every account. All
 * mutations go through a single in-process queue and are written atomically
 * (temp file + rename, previous revision kept as `users.json.bak`), so a crash
 * never leaves a half-written roster.
 *
 * Passwords are stored as `scrypt$N$r$p$salt$hash` (base64url). Verification is
 * constant-time. Nothing in this module ever returns a password hash to a
 * caller that renders it — `publicUser()` is the only shape the HTTP layer and
 * the model tools see.
 *
 * @module dsh-multi-user/store
 */

import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

/** scrypt cost parameters. N=16384 keeps unlock well under 100 ms on a laptop. */
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 32
/** scrypt needs N < 2^(16*maxmem/1024/...); raise the default memory cap so 128*N*r fits. */
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2

const STORE_VERSION = 1
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/
const ROLES = new Set(['admin', 'user'])
const STATUSES = new Set(['active', 'disabled'])

/** Anything a caller may hand us that is not a plain string. */
function text(value) {
  return typeof value === 'string' ? value : ''
}

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

function fromB64url(value) {
  return Buffer.from(value, 'base64url')
}

/**
 * Hash a password with scrypt.
 * @param password - the plaintext password.
 * @returns `scrypt$N$r$p$salt$hash`.
 */
export function hashPassword(password) {
  const salt = randomBytes(16)
  const derived = scryptSync(Buffer.from(String(password), 'utf8'), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
  })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${b64url(salt)}$${b64url(derived)}`
}

/**
 * Verify a password against a stored hash.
 * @param password - the candidate plaintext.
 * @param stored - the encoded hash produced by {@link hashPassword}.
 * @returns true only on an exact, constant-time match.
 */
export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  let salt
  let expected
  try {
    salt = fromB64url(parts[4])
    expected = fromB64url(parts[5])
  } catch {
    return false
  }
  let actual
  try {
    actual = scryptSync(Buffer.from(String(password), 'utf8'), salt, expected.length, {
      N: n, r, p, maxmem: Math.max(SCRYPT_MAXMEM, 128 * n * r * 2),
    })
  } catch {
    return false
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** A memorable but unguessable password for generated accounts. */
export function generatePassword(length = 14) {
  // Excludes look-alikes (0/O, 1/l/I) so a generated password survives being
  // read off a screen and retyped.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = randomBytes(length)
  let out = ''
  for (let index = 0; index < length; index += 1) {
    out += alphabet[bytes[index] % alphabet.length]
  }
  return out
}

/** Validate and normalize a username; returns undefined when unacceptable. */
export function normalizeUsername(value) {
  const name = text(value).trim()
  if (!USERNAME_PATTERN.test(name)) return undefined
  // Reserved on every filesystem we might place a home on.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) return undefined
  return name
}

/** Validate a role, defaulting to `user`. */
function normalizeRole(value, fallback = 'user') {
  const role = text(value).trim().toLowerCase()
  if (role === '') return fallback
  return ROLES.has(role) ? role : undefined
}

function normalizeStatus(value, fallback = 'active') {
  const status = text(value).trim().toLowerCase()
  if (status === '') return fallback
  return STATUSES.has(status) ? status : undefined
}

/** The public projection of a user: never carries the password hash. */
/**
 * Normalize the per-account UI blob stored on a user record.
 *
 * Today it only carries the floating sign-out pill's parked position. Every
 * value is validated: a corrupt entry must degrade to "no stored position"
 * (the pill falls back to its bottom-right default) rather than teleport the
 * widget off-screen or wedge the settings page.
 *
 * `x` and `y` are stored as fractions of the viewport (0..1) so the pill lands
 * in the same relative spot on a phone and on a 4K monitor. `side` records
 * which edge it is docked to, so the client never has to re-derive it.
 */
/**
 * Normalize the per-account UI blob stored on a user record.
 *
 * It carries the floating sign-out pill's parked position, plus whether the
 * user last left it collapsed into the round avatar button. Every value is
 * validated: a corrupt entry must degrade to "no stored position" (the pill
 * falls back to its bottom-right default) rather than teleport the widget
 * off-screen or wedge the settings page.
 *
 * `x` and `y` are stored as fractions of the viewport (0..1) so the pill lands
 * in the same relative spot on a phone and on a 4K monitor. `side` records
 * which edge it is docked to, so the client never has to re-derive it.
 * The default when collapsed is undefined is `false` (open), so accounts that
 * predate this feature are unaffected.
 */
export function normalizeUi(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {}
  const out = {}
  if (typeof input.collapsed === 'boolean') out.collapsed = input.collapsed
  const pill = input.pill
  if (pill !== null && typeof pill === 'object' && !Array.isArray(pill)) {
    const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
    const x = num(pill.x)
    const y = num(pill.y)
    if (x !== undefined && y !== undefined) {
      const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value)
      out.pill = {
        x: clamp01(x),
        y: clamp01(y),
        side: pill.side === 'left' ? 'left' : 'right',
      }
    }
  }
  return out
}

export function publicUser(user) {
  if (user === undefined || user === null) return undefined
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    note: user.note ?? '',
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt ?? null,
    homeMode: user.homeMode,
    homeDir: user.homeDir ?? null,
    workspaceDir: user.workspaceDir ?? null,
    port: user.port ?? null,
    shell: user.shell ?? null,
  }
}

/**
 * Reduce pasted text — one account per line — to import entries.
 *
 * Accepted line shapes (`,` or tab separated, `#` starts a comment):
 *   username
 *   username,password
 *   username,password,role
 *   username,password,role,note
 */
function entriesFromText(raw) {
  const entries = []
  let lineNumber = 0
  for (const line of raw.split(/\r?\n/)) {
    lineNumber += 1
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const fields = trimmed.split(/\s*[,\t]\s*/)
    entries.push({
      line: lineNumber,
      input: trimmed,
      username: fields[0],
      password: fields[1] ?? '',
      role: fields[2],
      status: undefined,
      note: fields[3] ?? '',
    })
  }
  return entries
}

/**
 * Reduce spreadsheet rows — already column-mapped by `spreadsheet.js` — to the
 * same intermediate shape as {@link entriesFromText}, so that conflict handling
 * lives in exactly one place for both import sources.
 */
function entriesFromRows(rows) {
  return rows.map((row, index) => {
    const shown = [row?.username, row?.password, row?.role, row?.note]
      .map((value) => text(value))
      .filter((value) => value.length > 0)
      .join(',')
    return {
      line: Number.isInteger(row?.line) ? row.line : index + 1,
      input: text(row?.input) || shown,
      username: text(row?.username).trim(),
      password: text(row?.password),
      role: row?.role,
      status: row?.status,
      note: text(row?.note),
    }
  })
}

/**
 * Create the user store.
 * @param config - resolved plugin configuration.
 * @param logger - optional `{ info, warn, error }` sink.
 * @returns the store API.
 */
export function createStore(config, logger = console) {
  let document = null
  /** Serializes every read-modify-write so concurrent HTTP calls cannot interleave. */
  let queue = Promise.resolve()

  function ensureDir() {
    if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  }

  function emptyDocument() {
    return { version: STORE_VERSION, createdAt: new Date().toISOString(), users: [] }
  }

  function load() {
    if (document !== null) return document
    ensureDir()
    if (!existsSync(config.usersFile)) {
      document = emptyDocument()
      persist()
      return document
    }
    let raw
    try {
      raw = JSON.parse(readFileSync(config.usersFile, 'utf8'))
    } catch (error) {
      throw new Error(
        `dsh-multi-user: ${config.usersFile} is not readable JSON (${error.message}). `
        + 'Fix or move it aside; the roster is never auto-reset to avoid silent account loss.',
      )
    }
    if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.users)) {
      throw new Error(`dsh-multi-user: ${config.usersFile} has an unexpected shape (expected { users: [...] })`)
    }
    document = { version: STORE_VERSION, createdAt: raw.createdAt ?? new Date().toISOString(), users: raw.users }
    return document
  }

  /** Atomic write: temp file in the same directory, fsync-by-rename, 0600. */
  function persist() {
    ensureDir()
    const payload = `${JSON.stringify(document, null, 2)}\n`
    const tmp = join(config.dataDir, `.users.json.tmp-${process.pid}`)
    writeFileSync(tmp, payload, { mode: 0o600 })
    try {
      chmodSync(tmp, 0o600)
    } catch {
      // Non-POSIX filesystems simply ignore the mode.
    }
    if (existsSync(config.usersFile)) {
      try {
        renameSync(config.usersFile, `${config.usersFile}.bak`)
      } catch {
        // A missing backup is not fatal; the next write retries.
      }
    }
    renameSync(tmp, config.usersFile)
  }

  /** Run one mutation under the write queue. */
  function mutate(work) {
    const run = queue.then(() => {
      const current = load()
      const result = work(current)
      persist()
      return result
    })
    // Keep the chain alive after a rejection, or one bad mutation would wedge
    // every later one.
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  function findIndex(doc, username) {
    const needle = text(username).trim().toLowerCase()
    return doc.users.findIndex((user) => String(user.username).toLowerCase() === needle)
  }

  function clone(user) {
    return JSON.parse(JSON.stringify(user))
  }

  const api = {
    /** The raw read-only snapshot (contains hashes — host-internal use only). */
    snapshot() {
      return clone(load())
    },

    list() {
      return load().users.map(publicUser)
    },

    count() {
      return load().users.length
    },

    /** Look up by username (case-insensitive). Returns a defensive copy. */
    find(username) {
      const doc = load()
      const at = findIndex(doc, username)
      return at === -1 ? undefined : clone(doc.users[at])
    },

    findById(id) {
      const doc = load()
      const user = doc.users.find((entry) => entry.id === id)
      return user === undefined ? undefined : clone(user)
    },

    hasRole(username, role) {
      const user = api.find(username)
      return user !== undefined && user.role === role && user.status === 'active'
    },

    /**
     * Verify a credential pair.
     * @param username - the claimed username.
     * @param password - the claimed password.
     * @returns the user record on success, or `{ error }` describing the refusal.
     */
    authenticate(username, password) {
      const user = api.find(username)
      // Always run a hash comparison so a missing account and a wrong password
      // cost the same wall-clock time.
      const stored = user?.passwordHash ?? hashPassword('dsh-multi-user-dummy')
      const ok = verifyPassword(password, stored)
      if (user === undefined || !ok) return { error: 'invalid' }
      if (user.status !== 'active') return { error: 'disabled' }
      return { user }
    },

    /** Record a successful sign-in. */
    async touchLogin(username) {
      return mutate((doc) => {
        const at = findIndex(doc, username)
        if (at === -1) return undefined
        doc.users[at].lastLoginAt = new Date().toISOString()
        return publicUser(doc.users[at])
      })
    },

    /**
     * Create one account.
     * @param input - `{ username, password, role, status, note, homeMode, homeDir, workspaceDir }`.
     * @returns `{ user }` or `{ error }`.
     */
    async create(input) {
      const username = normalizeUsername(input?.username)
      if (username === undefined) {
        return { error: '用户名只能包含字母、数字、点、下划线和短横线（1-32 位，须以字母或数字开头）' }
      }
      const role = normalizeRole(input?.role, 'user')
      if (role === undefined) return { error: `角色只能是 admin 或 user` }
      const status = normalizeStatus(input?.status, 'active')
      if (status === undefined) return { error: `状态只能是 active 或 disabled` }
      const password = text(input?.password)
      const generated = password.length === 0
      const effective = generated ? generatePassword() : password
      const created = await mutate((doc) => {
        if (findIndex(doc, username) !== -1) return { conflict: username }
        const at = new Date().toISOString()
        const user = {
          id: randomUUID(),
          username,
          passwordHash: hashPassword(effective),
          role,
          status,
          note: text(input?.note),
          createdAt: at,
          updatedAt: at,
          lastLoginAt: null,
          homeMode: text(input?.homeMode) || 'managed',
          homeDir: input?.homeDir ?? null,
          workspaceDir: input?.workspaceDir ?? null,
          port: Number.isInteger(input?.port) ? input.port : null,
          // Stable per-account ordinal. Inherited plugins that need a unique
          // resource (a sidecar port, a device index) derive it from this.
          slot: Number.isInteger(input?.slot) ? input.slot : null,
          ui: normalizeUi(input?.ui),
        }
        doc.users.push(user)
        return { user: clone(user) }
      })
      if (created.conflict !== undefined) {
        return { error: `用户 ${created.conflict} 已存在`, conflict: true }
      }
      return {
        user: publicUser(created.user),
        generatedPassword: generated ? effective : undefined,
      }
    },

    /**
     * Update one account by username.
     * @param username - the account to change.
     * @param patch - any of `{ role, status, password, note, homeMode, homeDir, workspaceDir, port }`.
     */
    async update(username, patch = {}) {
      const outcome = await mutate((doc) => {
        const at = findIndex(doc, username)
        if (at === -1) return { missing: true }
        const user = doc.users[at]
        if (patch.role !== undefined) {
          const role = normalizeRole(patch.role, user.role)
          if (role === undefined) return { error: '角色只能是 admin 或 user' }
          user.role = role
        }
        if (patch.status !== undefined) {
          const status = normalizeStatus(patch.status, user.status)
          if (status === undefined) return { error: '状态只能是 active 或 disabled' }
          user.status = status
        }
        if (patch.password !== undefined && text(patch.password).length > 0) {
          user.passwordHash = hashPassword(patch.password)
        }
        if (patch.note !== undefined) user.note = text(patch.note)
        if (patch.homeMode !== undefined && text(patch.homeMode).length > 0) user.homeMode = text(patch.homeMode)
        if (patch.homeDir !== undefined) user.homeDir = patch.homeDir
        if (patch.workspaceDir !== undefined) user.workspaceDir = patch.workspaceDir
        if (patch.port !== undefined) user.port = Number.isInteger(patch.port) ? patch.port : null
        if (patch.slot !== undefined) user.slot = Number.isInteger(patch.slot) ? patch.slot : null
        if (patch.ui !== undefined) user.ui = normalizeUi(patch.ui)
        user.updatedAt = new Date().toISOString()
        return { user: clone(user) }
      })
      if (outcome.missing) return { error: `用户 ${username} 不存在` }
      if (outcome.error !== undefined) return { error: outcome.error }
      return { user: publicUser(outcome.user) }
    },

    /**
     * Delete one account.
     * @param username - the account to remove.
     * @returns `{ user }` on success, `{ error }` otherwise. Refuses to remove
     * the last enabled administrator, which would lock everybody out.
     */
    async remove(username) {
      const outcome = await mutate((doc) => {
        const at = findIndex(doc, username)
        if (at === -1) return { missing: true }
        const user = doc.users[at]
        if (user.role === 'admin') {
          const remainingAdmins = doc.users.filter(
            (entry) => entry.role === 'admin' && entry.status === 'active' && entry.id !== user.id,
          )
          if (remainingAdmins.length === 0) return { error: '不能删除最后一个启用的管理员' }
        }
        doc.users.splice(at, 1)
        return { user: clone(user) }
      })
      if (outcome.missing) return { error: `用户 ${username} 不存在` }
      if (outcome.error !== undefined) return { error: outcome.error }
      return { user: publicUser(outcome.user) }
    },

    /**
     * Bulk upsert from pasted text or a parsed spreadsheet.
     *
     * Text is one account per line — `username`, `username,password`,
     * `username,password,role`, `username,password,role,note` (`,` or tab
     * separated, `#` starts a comment). A spreadsheet arrives as `body.rows`,
     * already column-mapped by `spreadsheet.js`; that path is also what gives
     * the import a per-row `status` column the text form has no room for.
     *
     * A blank password generates one. `onExisting: 'skip' | 'update'` decides
     * what happens when the username is already taken.
     *
     * @param body - `{ text, rows, defaultRole, defaultStatus, onExisting }`.
     * @returns a per-row report plus the created/updated account list.
     */
    async importUsers(body = {}) {
      const defaultRole = normalizeRole(body.defaultRole, 'user')
      if (defaultRole === undefined) return { error: 'defaultRole 只能是 admin 或 user' }
      const defaultStatus = normalizeStatus(body.defaultStatus, 'active')
      if (defaultStatus === undefined) return { error: 'defaultStatus 只能是 active 或 disabled' }
      const onExisting = body.onExisting === 'update' ? 'update' : 'skip'

      const entries = Array.isArray(body.rows) && body.rows.length > 0
        ? entriesFromRows(body.rows)
        : entriesFromText(text(body.text))

      const results = []
      const created = []
      const updated = []
      const skipped = []

      for (const entry of entries) {
        const { line, input } = entry
        const username = normalizeUsername(entry.username)
        if (username === undefined) {
          results.push({ line, input, status: 'error', message: `非法用户名 ${JSON.stringify(entry.username)}` })
          continue
        }
        const password = text(entry.password)
        const role = normalizeRole(entry.role, defaultRole)
        if (role === undefined) {
          results.push({ line, input, status: 'error', message: `非法角色 ${JSON.stringify(entry.role)}` })
          continue
        }
        const status = normalizeStatus(entry.status, defaultStatus)
        if (status === undefined) {
          results.push({ line, input, status: 'error', message: `非法状态 ${JSON.stringify(entry.status)}` })
          continue
        }
        const note = text(entry.note)
        const existing = api.find(username)
        if (existing !== undefined && onExisting === 'skip') {
          skipped.push(username)
          results.push({ line, input, status: 'skipped', message: `${username} 已存在，跳过` })
          continue
        }
        if (existing !== undefined) {
          const outcome = await api.update(username, {
            role,
            status,
            note,
            ...(password.length > 0 ? { password } : {}),
          })
          if (outcome.error !== undefined) {
            results.push({ line, input, status: 'error', message: outcome.error })
          } else {
            updated.push(username)
            results.push({ line, input, status: 'updated', message: `${username} 已更新`, username })
          }
          continue
        }
        const outcome = await api.create({ username, password, role, status, note })
        if (outcome.error !== undefined) {
          results.push({ line, input, status: 'error', message: outcome.error })
          continue
        }
        created.push(username)
        results.push({
          line,
          input,
          status: 'created',
          message: `${username} 已创建`,
          username,
          generatedPassword: outcome.generatedPassword,
        })
      }

      return {
        summary: {
          total: results.length,
          created: created.length,
          updated: updated.length,
          skipped: skipped.length,
          failed: results.filter((row) => row.status === 'error').length,
        },
        created,
        updated,
        skipped,
        results,
      }
    },
  }

  return api
}
