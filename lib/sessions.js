/**
 * dsh-multi-user — gateway login sessions and login throttling.
 *
 * A login session is an opaque random token in an HttpOnly cookie, backed by
 * `<dataDir>/sessions.json`. Keeping them server-side (rather than a signed
 * cookie) is what makes "change the password / disable the account → every
 * existing session dies immediately" possible.
 *
 * @module dsh-multi-user/sessions
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Cookie name carrying the gateway session token. */
export const SESSION_COOKIE = 'dsh_mu_session'

const SAVE_DEBOUNCE_MS = 200

/**
 * Create the session manager.
 * @param config - resolved plugin configuration.
 * @param logger - optional log sink.
 */
export function createSessionManager(config, logger = console) {
  const ttlMs = Math.max(1, config.sessionTtlHours) * 60 * 60 * 1000
  /** token -> { username, issuedAt, expiresAt, ip, userAgent } */
  let sessions = new Map()
  /** ip -> { failures, lockedUntil } */
  const throttles = new Map()
  let saveTimer = null
  let dirty = false

  function load() {
    if (!existsSync(config.sessionsFile)) return
    try {
      const raw = JSON.parse(readFileSync(config.sessionsFile, 'utf8'))
      const entries = Array.isArray(raw?.sessions) ? raw.sessions : []
      const now = Date.now()
      sessions = new Map(
        entries
          .filter((entry) => entry && typeof entry.token === 'string' && entry.expiresAt > now)
          .map((entry) => [entry.token, entry]),
      )
    } catch (error) {
      logger.warn?.(`dsh-multi-user: ignoring unreadable ${config.sessionsFile}: ${error.message}`)
      sessions = new Map()
    }
  }

  function saveNow() {
    if (!dirty) return
    dirty = false
    const payload = {
      version: 1,
      savedAt: new Date().toISOString(),
      sessions: [...sessions.values()],
    }
    try {
      const tmp = join(config.dataDir, `.sessions.json.tmp-${process.pid}`)
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
      if (existsSync(config.sessionsFile)) {
        try {
          renameSync(config.sessionsFile, `${config.sessionsFile}.bak`)
        } catch {
          // best effort
        }
      }
      renameSync(tmp, config.sessionsFile)
    } catch (error) {
      logger.warn?.(`dsh-multi-user: could not persist sessions: ${error.message}`)
    }
  }

  function markDirty() {
    dirty = true
    if (saveTimer !== null) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveNow()
    }, SAVE_DEBOUNCE_MS)
    saveTimer.unref?.()
  }

  load()

  const api = {
    /** Issue a session token for a verified user. */
    issue(username, context = {}) {
      const token = randomBytes(32).toString('base64url')
      const now = Date.now()
      sessions.set(token, {
        token,
        username,
        issuedAt: now,
        expiresAt: now + ttlMs,
        ip: context.ip ?? null,
        userAgent: String(context.userAgent ?? '').slice(0, 200),
      })
      markDirty()
      return { token, expiresAt: now + ttlMs }
    },

    /**
     * Resolve a token to a live session.
     * @param token - cookie value.
     * @returns the session record, or undefined when absent/expired.
     */
    resolve(token) {
      if (typeof token !== 'string' || token.length === 0) return undefined
      const session = sessions.get(token)
      if (session === undefined) return undefined
      if (session.expiresAt <= Date.now()) {
        sessions.delete(token)
        markDirty()
        return undefined
      }
      return session
    },

    /**
     * Sliding renewal: when a live session is past the renewal threshold, extend
     * it to a full TTL from now, so an account that keeps using the gateway is
     * never logged out mid-work (e.g. while an Agent Team is running). Unused
     * sessions still expire `sessionTtlHours` after issue.
     * @param token - cookie value.
     * @returns the new expiresAt when the session was renewed, else undefined.
     */
    renewIfDue(token) {
      const session = sessions.get(token)
      if (session === undefined) return undefined
      const now = Date.now()
      if (session.expiresAt <= now) return undefined
      const thresholdHours = config.sessionRenewThresholdHours ?? (config.sessionTtlHours / 4)
      const thresholdMs = Math.min(Math.max(0, thresholdHours) * 60 * 60 * 1000, ttlMs)
      if (session.expiresAt - now > thresholdMs) return undefined
      session.expiresAt = now + ttlMs
      session.renewedAt = now
      markDirty()
      return session.expiresAt
    },

    /** Drop one session (sign out). */
    revoke(token) {
      if (sessions.delete(token)) markDirty()
    },

    /** Drop every session belonging to a user (password change, disable, delete). */
    revokeUser(username) {
      let removed = 0
      for (const [token, session] of sessions) {
        if (session.username === username) {
          sessions.delete(token)
          removed += 1
        }
      }
      if (removed > 0) markDirty()
      return removed
    },

    /** Drop every session (roster-wide invalidation). */
    revokeAll() {
      const removed = sessions.size
      sessions.clear()
      markDirty()
      return removed
    },

    /** Live session count, optionally for one user. */
    stats(username) {
      const now = Date.now()
      const live = [...sessions.values()].filter((session) => session.expiresAt > now)
      return {
        total: live.length,
        forUser: username === undefined ? undefined : live.filter((s) => s.username === username).length,
      }
    },

    /** Whether this IP is currently locked out of the login form. */
    isLocked(ip) {
      const entry = throttles.get(ip)
      if (entry === undefined) return { locked: false, remainingMs: 0 }
      if (entry.lockedUntil > Date.now()) {
        return { locked: true, remainingMs: entry.lockedUntil - Date.now() }
      }
      return { locked: false, remainingMs: 0 }
    },

    /** Record one failed login; returns the remaining attempts before lockout. */
    recordFailure(ip) {
      const max = config.loginMaxFailures
      if (max <= 0) return { remaining: Infinity }
      const entry = throttles.get(ip) ?? { failures: 0, lockedUntil: 0 }
      entry.failures += 1
      if (entry.failures >= max) {
        entry.lockedUntil = Date.now() + config.loginLockMinutes * 60 * 1000
        entry.failures = 0
      }
      throttles.set(ip, entry)
      if (entry.lockedUntil > Date.now()) {
        return { remaining: 0, lockedMs: entry.lockedUntil - Date.now() }
      }
      return { remaining: max - entry.failures }
    },

    /** Clear the failure counter after a successful login. */
    recordSuccess(ip) {
      throttles.delete(ip)
    },
  }

  return api
}

/** Serialize a Set-Cookie header for the gateway session. */
export function sessionCookie(token, expiresAt, { secure = false } = {}) {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/** Serialize a Set-Cookie header that clears the gateway session. */
export function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
}

/** Extract one cookie value without pulling in a cookie parser. */
export function readCookie(headerValue, name) {
  if (typeof headerValue !== 'string' || headerValue.length === 0) return undefined
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}
