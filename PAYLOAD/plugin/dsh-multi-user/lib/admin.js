/**
 * dsh-multi-user — account operations, shared by the HTTP admin API and the
 * model-facing host tools so both obey exactly the same rules.
 *
 * @module dsh-multi-user/admin
 */

import { generatePassword } from './store.js'

/** Shape returned to callers: never contains a password hash. */
function shape(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    note: user.note ?? '',
    homeMode: user.homeMode,
    homeDir: user.homeDir ?? null,
    workspaceDir: user.workspaceDir ?? null,
    port: user.port ?? null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt ?? null,
  }
}

/**
 * Build the admin facade.
 * @param deps - `{ config, store, sessions, supervisor, logger }`.
 */
export function createAdmin(deps) {
  const { store, sessions, supervisor } = deps
  const logger = deps.logger ?? console

  /**
   * The next free per-account ordinal.
   *
   * Inherited applications that need a unique resource (a sidecar port, a
   * device index) derive it from this, so it has to be stable for the life of
   * the account and never reused while another account could hold it.
   */
  function nextSlot() {
    const used = new Set(
      store
        .snapshot()
        .users.map((user) => user.slot)
        .filter((value) => Number.isInteger(value))
    )
    let slot = 0
    while (used.has(slot)) slot += 1
    return slot
  
  }

  const api = {
    list() {
      return store.list().map(shape)
    },

    /**
     * Create an account plus its private space.
     * @param input - `{ username, password, role, status, note }`.
     */
    async create(input, actor = 'system') {
      const outcome = await store.create({ ...input, homeMode: 'managed', slot: nextSlot() })
      if (outcome.error !== undefined) return outcome
      const record = store.find(outcome.user.username)
      if (record === undefined) return outcome
      // Materialize the space first, then seed it: the directories must exist
      // even when there is nothing to copy.
      const { home, workspace } = supervisor.ensureSpace(record)
      const seeded = supervisor.seedUserHome(record)
      // Give the new account the host's applications straight away, so the
      // first sign-in already shows what the administrator installed.
      const profile = await supervisor.syncProfile(record)
      const updated = await store.update(record.username, { homeDir: home, workspaceDir: workspace })
      logger.info?.(
        `dsh-multi-user: ${actor} created ${record.username} (home=${home}, seeded=${seeded.join(',') || 'none'}, `
        + `apps=${(profile.apps ?? []).length})`,
      )
      return {
        user: updated.user ?? shape(record),
        generatedPassword: outcome.generatedPassword,
        homeDir: home,
        workspaceDir: workspace,
        seeded,
        apps: profile.apps ?? [],
      }
    },

    /**
     * Update an account.
     * @param username - target account.
     * @param patch - `{ role, status, password, note }`. A blank password means
     * "reset to a freshly generated one" when `rotatePassword` is set.
     * @param options - `{ actor, rotatePassword }`.
     */
    async update(username, patch = {}, options = {}) {
      const existing = store.find(username)
      if (existing === undefined) return { error: `用户 ${username} 不存在` }
      const requested = { ...patch }
      let generatedPassword
      if (options.rotatePassword === true && (patch.password === undefined || String(patch.password).length === 0)) {
        generatedPassword = generatePassword()
        requested.password = generatedPassword
      }
      const outcome = await store.update(username, requested)
      if (outcome.error !== undefined) return outcome
      const invalidating = requested.password !== undefined || requested.status !== undefined
      const revokedSessions = invalidating ? sessions.revokeUser(username) : 0
      if (requested.status === 'disabled') supervisor.stop(username)
      logger.info?.(
        `dsh-multi-user: ${options.actor ?? 'system'} updated ${username} `
        + `(${Object.keys(requested).filter((key) => requested[key] !== undefined).join(',') || 'noop'})`,
      )
      return {
        user: outcome.user,
        revokedSessions,
        generatedPassword,
        restarted: invalidating && requested.status !== 'disabled',
      }
    },

    /**
     * Delete an account.
     * @param username - target account.
     * @param options - `{ actor, purge }`. `purge: true` also removes the
     * account's data directory; the default keeps it for recovery.
     */
    async remove(username, options = {}) {
      const actor = options.actor ?? 'system'
      if (options.forbidSelf === true && username === actor) {
        return { error: '不能删除当前登录的管理员账号' }
      }
      const existing = store.find(username)
      if (existing === undefined) return { error: `用户 ${username} 不存在` }
      const outcome = await store.remove(username)
      if (outcome.error !== undefined) return outcome
      supervisor.stop(username)
      const revokedSessions = sessions.revokeUser(username)
      const spaceDir = supervisor.dataDirOf(username)
      let purged = false
      if (options.purge === true) {
        const { rmSync } = await import('node:fs')
        try {
          rmSync(spaceDir, { recursive: true, force: true })
          purged = true
        } catch (error) {
          logger.warn?.(`dsh-multi-user: could not purge ${spaceDir}: ${error.message}`)
        }
      }
      logger.info?.(`dsh-multi-user: ${actor} deleted ${username} (purge=${String(purged)}, revokedSessions=${revokedSessions})`)
      return {
        user: outcome.user,
        revokedSessions,
        spaceDirKept: purged ? undefined : spaceDir,
        purged,
      }
    },

    /** Bulk upsert from pasted text. */
    async import(body = {}) {
      const result = await store.importUsers(body)
      if (result.error !== undefined) return result
      // Materialize spaces for every account the import touched, so the roster
      // shown to the operator matches what actually exists on disk.
      const touched = [...(result.created ?? []), ...(result.updated ?? [])]
      const prepared = []
      for (const username of touched) {
        const record = store.find(username)
        if (record === undefined) continue
        const { home, workspace } = supervisor.ensureSpace(record)
        const seeded = record.homeDir === null ? supervisor.seedUserHome(record) : []
        const patch = { homeDir: home, workspaceDir: workspace }
        // The ordinal must exist before mirroring: the per-account overrides
        // are rendered from it.
        if (!Number.isInteger(record.slot)) patch.slot = nextSlot()
        // eslint-disable-next-line no-await-in-loop -- one account at a time keeps I/O bounded
        await store.update(username, patch)
        const profile = await supervisor.syncProfile(store.find(username) ?? record)
        prepared.push({ username, homeDir: home, workspaceDir: workspace, seeded, apps: profile.apps ?? [] })
      }
      return { ...result, prepared }
    },

    /** Gateway + instance status. */
    status(extra = {}) {
      return {
        gateway: {
          ...extra,
          users: store.count(),
          sessions: sessions.stats().total,
          adminHomeMode: deps.config.adminHomeMode,
          dataDir: deps.config.dataDir,
          dshRoot: deps.config.dshRoot,
          launcher: supervisor.launcher(),
          profile: supervisor.profileInfo(),
          apps: supervisor.hostApps(),
          minPasswordLength: deps.config.minPasswordLength,
        },
        instances: supervisor.status(),
      }
    },

    /** The applications every account inherits from the host profile. */
    apps() {
      return { ...supervisor.profileInfo(), apps: supervisor.hostApps() }
    },

    shape,
  }

  return api
}
