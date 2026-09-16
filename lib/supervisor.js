/**
 * dsh-multi-user — per-user DSH instance supervisor.
 *
 * The isolation guarantee of this plugin is structural, not cosmetic: each
 * account is served by its OWN `dsh web` process with its own `$DSH_HOME`.
 * Sessions, credentials, settings, profiles, storages and workspaces therefore
 * live in physically separate directories, and nothing in one account can name
 * another account's data.
 *
 * Instances are spawned on first request, kept warm, and stopped after an idle
 * period. The instance that hosts this plugin (`adminHomeMode: 'host'`) is
 * never spawned and never reaped — the admin keeps using it as-is.
 *
 * @module dsh-multi-user/supervisor
 */

import { spawn } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { delimiter, dirname, join } from 'node:path'

const REAP_INTERVAL_MS = 60_000
const READY_POLL_MS = 750

/** How long a computed host-profile signature is trusted, so repeated requests do not re-hash. */
const HOST_SIG_TTL_MS = 5_000

/** Records which host application set a user space was last mirrored from. */
const SYNC_MARKER = '.dshmu-profile-sync.json'

/**
 * Profile entries that are never mirrored into a user space: the harness
 * rebuilds its own fallback tree, installer backups are history rather than
 * configuration, and our own bookkeeping stays put.
 */
const PROFILE_ENTRY_DENY = [/^\.dsh-module-fallback$/, /\.bak(-|\.|$)/, /^\.dshmu-/]

/** Fences the block we own inside a user profile's `cordis.patch.yml`. */
const PATCH_BLOCK_START = '# >>> dsh-multi-user: managed overrides — regenerated on every sync, do not edit >>>'
const PATCH_BLOCK_END = '# <<< dsh-multi-user: managed overrides <<<'

/**
 * Extra profile rows every NON-administrator account composes.
 *
 * Both rows disable a plugin, so an account that does not mount one simply has
 * no such surface at all. That is the whole point: these are administrator
 * capabilities, and hiding the entry point is the first of two layers (the
 * gateway fences the same features on the wire; see `guardAccountRequest`).
 *
 * - `ui-settings-models` registers 设置 → 模型（provider/model catalogue
 *   editor）. The account keeps full *use* of the models: the administrator's
 *   catalogue is mirrored into its settings by `syncAdminModels`, the in-chat
 *   model picker is a different plugin (`ui-model-selection`, untouched), and
 *   `agent-default-model` stays writable so every account can still choose the
 *   model it talks to.
 * - `ui-sidebar-terminal` registers the right sidebar's terminal tab type and
 *   its 「新建终端」 guide entry. A browser terminal runs as the one shared
 *   Linux user, so it reaches every account's files however carefully the
 *   picker and file fences are drawn — which is why ordinary accounts get no
 *   terminal at all. The agent's own command tools are unaffected: those run
 *   in-process and are not this wire.
 */
const NON_ADMIN_PATCH_ROWS = [
  '- id: ui-settings-models',
  '  disabled: true',
  '- id: ui-sidebar-terminal',
  '  disabled: true',
].join('\n')

/** Whether one account record carries the administrator role. */
export function isAdministrator(user) {
  return String(user?.role ?? '').toLowerCase() === 'admin'
}

/** Escape a literal string for use inside a RegExp. */
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Content signature of everything a mirror adds on TOP of the host's own files
 * — the rendered per-account patch and the declared read-only links.
 *
 * It has to take part in the "is this mirror already current?" decision: the
 * administrator edits these in the plugin config, not on the host's disk, so
 * the host signature alone would never notice, and an account created before
 * the edit would keep the stale overrides forever.
 *
 * @returns `''` when there is nothing to apply, otherwise a short hex digest.
 */
function overrideSignature(patch, links) {
  const text = String(patch ?? '').trim()
  const linkText = Object.entries(links ?? {})
    .filter(([relative, target]) => (
      typeof relative === 'string' && relative.length > 0
      && typeof target === 'string' && target.length > 0
    ))
    .map(([relative, target]) => `${relative}=${target}`)
    .sort()
    .join('\n')
  if (text.length === 0 && linkText.length === 0) return ''
  return createHash('sha256').update(`${text}\0${linkText}`).digest('hex').slice(0, 32)
}

/** Read a file as UTF-8, returning `''` when it is absent or unreadable. */
function readPatchText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Read a sync marker, treating anything unreadable or corrupt as "no marker". */
function readSyncMarker(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

/**
 * Whether a `cordis.patch.yml` holds anything besides comments and an empty
 * list. A stock file is exactly `[]`, which means "no overrides yet" — as
 * opposed to a patch the user actually wrote.
 */
function hasPatchContent(text) {
  const body = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .join('')
  return body !== '' && body !== '[]'
}

/** Probe whether a loopback port is free. */
function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolvePromise) => {
    const probe = createServer()
    probe.unref()
    probe.once('error', () => resolvePromise(false))
    probe.listen(port, host, () => {
      probe.close(() => resolvePromise(true))
    })
  })
}

/** Find a free loopback port at or after `start`, then let the OS choose. */
async function allocatePort(start, range) {
  for (let offset = 0; offset < range; offset += 1) {
    const candidate = start + offset
    if (candidate > 65535) break
    // eslint-disable-next-line no-await-in-loop -- probing is inherently sequential
    if (await isPortFree(candidate)) return candidate
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const probe = createServer()
    probe.unref()
    probe.once('error', rejectPromise)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const chosen = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolvePromise(chosen))
    })
  })
}

/**
 * Exchange a launch token for the authority-bound browser cookie DSH expects.
 * @param port - loopback port of the instance.
 * @param token - that instance's `DSH_WEB_TOKEN`.
 * @returns `{ cookie, status }` — `cookie` is undefined when the exchange failed.
 */
function exchangeToken(port, token) {
  return new Promise((resolvePromise) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: `/?token=${encodeURIComponent(token)}`,
        headers: { host: `127.0.0.1:${port}`, accept: 'text/html', 'accept-encoding': 'identity' },
      },
      (res) => {
        res.resume()
        const raw = res.headers['set-cookie']
        const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
        const auth = list.find((entry) => entry.startsWith('dsh-auth-'))
        resolvePromise({
          status: res.statusCode ?? 0,
          cookie: auth === undefined ? undefined : auth.split(';')[0],
        })
      },
    )
    req.setTimeout(5000, () => req.destroy(new Error('token exchange timed out')))
    req.on('error', () => resolvePromise({ status: 0, cookie: undefined }))
    req.end()
  })
}

/**
 * Create the supervisor.
 * @param config - resolved plugin configuration.
 * @param deps - `{ hostPort(), logger }`.
 */
export function createSupervisor(config, deps = {}) {
  const logger = deps.logger ?? console
  /** username -> instance record */
  const instances = new Map()
  let reaper = null
  let stopped = false

  if (config.idleTimeoutMinutes > 0) {
    reaper = setInterval(() => {
      void reap()
    }, REAP_INTERVAL_MS)
    reaper.unref?.()
  }

  function ensureDirs() {
    if (!existsSync(config.logDir)) mkdirSync(config.logDir, { recursive: true, mode: 0o700 })
    if (!existsSync(config.usersDir)) mkdirSync(config.usersDir, { recursive: true, mode: 0o700 })
  }

  /** The user's private harness home, created on demand. */
  function homeOf(user) {
    if (typeof user.homeDir === 'string' && user.homeDir.length > 0) return user.homeDir
    return join(config.usersDir, user.username, 'home')
  }

  /** The user's private workspace, created on demand. */
  function workspaceOf(user) {
    if (typeof user.workspaceDir === 'string' && user.workspaceDir.length > 0) return user.workspaceDir
    return join(config.usersDir, user.username, 'workspace')
  }

  /**
   * Materialize a user's private space on disk.
   *
   * Called when the account is created, not only when its instance first
   * starts: an operator who creates an account and immediately looks at the
   * data directory should see the space exist, and a workspace the user can
   * drop files into should be there before the process that uses it.
   *
   * @param user - the account record.
   * @returns `{ home, workspace }`.
   */
  function ensureSpace(user) {
    ensureDirs()
    const home = homeOf(user)
    const workspace = workspaceOf(user)
    mkdirSync(home, { recursive: true, mode: 0o700 })
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    return { home, workspace }
  }

  /**
   * Seed a brand-new account with the host's model credentials so the account
   * is usable on first sign-in instead of demanding its own API key.
   */
  function seedUserHome(user) {
    if (!config.seedOnCreate) return []
    const source = deps.hostHome?.()
    if (typeof source !== 'string' || !existsSync(source)) return []
    const target = homeOf(user)
    mkdirSync(target, { recursive: true, mode: 0o700 })
    const copied = []
    for (const name of config.seedFiles) {
      const from = join(source, name)
      if (!existsSync(from)) continue
      const to = join(target, name)
      try {
        if (statSync(from).isDirectory()) {
          cpSync(from, to, { recursive: true })
        } else {
          copyFileSync(from, to)
        }
        copied.push(name)
      } catch (error) {
        logger.warn?.(`dsh-multi-user: could not seed ${name} for ${user.username}: ${error.message}`)
      }
    }
    return copied
  }

  /** The bundle list a profile's `package.json` declares. */
  function readProfileApps(profileDir) {
    try {
      const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
      const bundles = manifest?.dsh?.profile?.bundles
      return Array.isArray(bundles) ? bundles.filter((item) => typeof item === 'string') : []
    } catch {
      return []
    }
  }

  /** Content signature of the host profile's application set. */
  let hostSignatureCache = { value: null, at: 0 }
  function hostProfileSignature(source) {
    const ttl = Number.isFinite(config.appSyncIntervalMs) ? config.appSyncIntervalMs : HOST_SIG_TTL_MS
    const now = Date.now()
    if (hostSignatureCache.value !== null && now - hostSignatureCache.at < ttl) {
      return hostSignatureCache.value
    }
    const digest = createHash('sha256')
    for (const name of ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      digest.update(`${name}\0`)
      try {
        digest.update(readFileSync(join(source, name)))
      } catch {
        digest.update('missing')
      }
      digest.update('\0')
    }
    // The top-level node_modules listing is what actually changes when a plugin
    // is added or removed, so it belongs in the signature too.
    try {
      digest.update(readdirSync(join(source, 'node_modules')).sort().join(','))
    } catch {
      digest.update('no-node_modules')
    }
    const value = digest.digest('hex').slice(0, 32)
    hostSignatureCache = { value, at: now }
    return value
  }

  /**
   * Mirror the host profile's application set into one user's private home.
   *
   * Every account runs its own `dsh` with its own `$DSH_HOME`, so the profile
   * tree the host uses — its `package.json` bundle list and its installed
   * `node_modules` — is not visible inside an account. Without this step a user
   * sees a bare harness while the host has plugins (a knowledge base, tool
   * bundles); with it, an application installed once on the host is available
   * to everyone, while each account keeps its own data, sessions and
   * credentials.
   *
   * Cheap to call on every request: the host profile's content signature is
   * compared against the last mirror, and nothing is copied when it matches.
   *
   * @param user - the account record.
   * @returns `{ synced, changed?, unchanged?, apps?, reason? }`.
   */
  /**
   * Read one top-level `key:` block (plus its indented body) out of a YAML doc.
   */
  function readTopLevelBlock(text, key) {
    const lines = String(text).split('\n')
    const isKey = (l) => l === `${key}:` || l.startsWith(`${key}: `) || l.startsWith(`${key}:\t`)
    const start = lines.findIndex(isKey)
    if (start < 0) return null
    let end = lines.length
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (line.trim().length === 0) continue
      if (/^\s/.test(line)) continue
      break
    }
    return lines.slice(start, end).join('\n').replace(/\s+$/, '')
  }

  /** Replace (or append) one top-level block, leaving every other key alone. */
  function writeTopLevelBlock(text, key, block) {
    const lines = String(text).split('\n')
    const isKey = (l) => l === `${key}:` || l.startsWith(`${key}: `) || l.startsWith(`${key}:\t`)
    const start = lines.findIndex(isKey)
    if (start < 0) {
      const base = String(text).replace(/\s+$/, '')
      return base ? `${base}\n${block}\n` : `${block}\n`
    }
    let end = lines.length
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (line.trim().length === 0) continue
      if (/^\s/.test(line)) continue
      break
    }
    return [...lines.slice(0, start), ...block.split('\n'), ...lines.slice(end)].join('\n')
  }

  /**
   * The DSH home whose `settings.yaml` owns the deployment's model catalogue.
   *
   * The administrator edits 设置 → 模型 inside their own managed instance, so
   * that account's `settings.yaml` is the live source of truth; the host's file
   * is only the seed it started from. Reading the host instead is what let
   * ordinary accounts inherit models the administrator had already removed —
   * measured on 192.168.8.6: host 30 models, administrator 11, accounts 30.
   *
   * @returns the catalogue home, or undefined when neither is available.
   */
  function catalogueHome() {
    const admin = deps.adminHome?.()
    if (typeof admin === 'string' && admin.length > 0 && existsSync(join(admin, 'settings.yaml'))) {
      return admin
    }
    const host = deps.hostHome?.()
    return typeof host === 'string' && host.length > 0 ? host : undefined
  }

  /**
   * Mirror the administrator's model catalogue into an account.
   *
   * `llm-pi-ai:` is the single source of truth for which providers and models
   * exist, so an ordinary account never has to configure them and can only pick
   * from what the administrator published. Only that one top-level block is
   * replaced — the account keeps its own UI preferences, onboarding flags, and
   * its own `agent-default-model` choice.
   */
  function syncAdminModels(user, home) {
    const source = catalogueHome()
    if (source === undefined) return { synced: false, reason: 'no catalogue home is known' }
    const from = join(source, 'settings.yaml')
    if (!existsSync(from)) return { synced: false, reason: 'catalogue settings.yaml is missing' }
    let sourceText = ''
    try {
      sourceText = readFileSync(from, 'utf8')
    } catch (error) {
      return { synced: false, reason: error.message }
    }
    const block = readTopLevelBlock(sourceText, 'llm-pi-ai')
    if (!block) return { synced: false, reason: 'catalogue settings.yaml has no llm-pi-ai block' }
    const to = join(home, 'settings.yaml')
    let userText = ''
    if (existsSync(to)) {
      try {
        userText = readFileSync(to, 'utf8')
      } catch {
        userText = ''
      }
    }
    const next = writeTopLevelBlock(userText, 'llm-pi-ai', block)
    if (next === userText) return { synced: false, unchanged: true }
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 })
      writeFileSync(to, next, { mode: 0o600 })
    } catch (error) {
      return { synced: false, reason: error.message }
    }
    logger.info?.(`dsh-multi-user: inherited administrator model catalogue for ${user.username}`)
    return { synced: true }
  }

  /**
   * How often a running account re-checks the catalogue it inherits.
   *
   * An edit is rare, so the check is throttled rather than run on every request
   * — but it does run on the *request* path, not only at boot: `syncAdminModels`
   * is otherwise reachable only from `start()`, so an instance that was already
   * running when the administrator changed a model would keep serving the old
   * catalogue for as long as it stayed up.
   *
   * No restart is involved: the instance watches its own `settings.yaml` and
   * re-reads the block in place. Measured on 192.168.8.6 — a model spliced into
   * an account's file appears in its live `session/modelCatalog` within 8s, and
   * disappears just as fast when removed. One caveat, measured on the same box:
   * a *malformed* document does not degrade gracefully — the settings provider
   * rejects it and the whole `llm-pi-ai` block goes missing, leaving only the
   * built-in provider's models. Our writer cannot cause that, because it splices
   * a block copied verbatim from the administrator's own working file.
   */
  const CATALOGUE_RECHECK_MS = 30_000

  /** username -> when its catalogue was last mirrored, to keep this off the hot path. */
  const catalogueCheckedAt = new Map()

  /**
   * Mirror the catalogue into a running account, at most once per interval.
   *
   * The write is the whole mechanism: the account's instance watches the file,
   * so a change lands in its live catalogue within seconds and no restart or
   * in-process RPC is needed.
   *
   * @param user - the account record.
   * @returns whether the account's settings actually changed.
   */
  function refreshAdminModels(user) {
    const now = Date.now()
    if (now - (catalogueCheckedAt.get(user.username) ?? 0) < CATALOGUE_RECHECK_MS) return false
    catalogueCheckedAt.set(user.username, now)
    return syncAdminModels(user, homeOf(user)).synced === true
  }

  async function syncProfile(user) {
    if (!config.inheritProfile) return { synced: false, reason: 'inheritProfile is off' }
    const hostHome = deps.hostHome?.()
    if (typeof hostHome !== 'string' || hostHome.length === 0) {
      return { synced: false, reason: 'host DSH home is unknown' }
    }
    const source = join(hostHome, 'profiles', config.profile)
    if (!existsSync(source)) {
      return { synced: false, reason: `host has no profiles/${config.profile}` }
    }
    const home = homeOf(user)
    const workspace = workspaceOf(user)

    // Accounts created before per-account overrides existed carry no ordinal
    // yet. Claim one first: the overrides below derive their port from it.
    if (
      String(config.userProfilePatch ?? '').trim().length > 0
      && !Number.isInteger(user.slot)
      && typeof deps.claimSlot === 'function'
    ) {
      try {
        user = { ...user, slot: await deps.claimSlot(user.username) }
      } catch (error) {
        logger.warn?.(`dsh-multi-user: could not allocate an ordinal for ${user.username}: ${error.message}`)
      }
    }
    const desiredPatch = renderUserPatch(user, home, workspace)
    const overrides = overrideSignature(desiredPatch, config.userSeedLinks)

    const signature = hostProfileSignature(source)
    const target = join(home, 'profiles', config.profile)
    const patchFile = join(target, 'cordis.patch.yml')
    const marker = join(target, SYNC_MARKER)
    const previous = readSyncMarker(marker)
    const mirrorPresent = existsSync(join(target, 'package.json')) && existsSync(join(target, 'node_modules'))
    // Two independent reasons to redo the work: the host changed what it
    // offers, or the administrator changed what an account looks like on top.
    const hostChanged = previous?.signature !== signature || !mirrorPresent
    // A marker only counts if the file it describes is still usable. This also
    // repairs damage done by an older build instead of leaving it pinned.
    const patchHealthy = countEmptyLists(readPatchText(patchFile)) <= 1
    if (!hostChanged && (previous?.overrides ?? '') === overrides && patchHealthy) {
      return { synced: false, unchanged: true, signature, overrides, apps: previous.apps ?? [] }
    }

    const copied = []
    if (hostChanged) {
      let entries
      try {
        entries = readdirSync(source)
      } catch (error) {
        return { synced: false, reason: `cannot read ${source}: ${error.message}` }
      }
      mkdirSync(target, { recursive: true, mode: 0o700 })
      for (const entry of entries) {
        if (PROFILE_ENTRY_DENY.some((pattern) => pattern.test(entry))) continue
        const from = join(source, entry)
        const to = join(target, entry)
        // A patch file the user actually wrote is theirs; a stock `[]` is not an
        // opinion and may be replaced. Everything else is the administrator's.
        if (entry === 'cordis.patch.yml' && existsSync(to)) {
          let existing = ''
          try {
            existing = readFileSync(to, 'utf8')
          } catch {
            // unreadable → treat as absent and let the host copy win
          }
          if (hasPatchContent(existing)) continue
        }
        try {
          // Replace rather than merge: a plugin the host removed must disappear.
          if (entry === 'node_modules') rmSync(to, { recursive: true, force: true })
          cpSync(from, to, { recursive: true, force: true })
          copied.push(entry)
        } catch (error) {
          logger.warn?.(
            `dsh-multi-user: could not mirror profiles/${config.profile}/${entry} for ${user.username}: ${error.message}`,
          )
        }
      }
    }

    // Per-account overrides and shared read-only bulk come last, so the profile
    // copy above cannot overwrite them.
    let patchApplied = false
    if (desiredPatch.trim().length > 0) {
      patchApplied = applyManagedPatch(patchFile, desiredPatch, user.username)
    } else if (overrides === '') {
      // The administrator cleared the overrides: take our block back out rather
      // than leaving an account pinned to a configuration nobody declares.
      patchApplied = applyManagedPatch(patchFile, '', user.username)
    }
    const links = linkSeedPaths(user, home)
    if (links.length > 0) logger.info?.(`dsh-multi-user: linked ${links.join(', ')} for ${user.username}`)

    const apps = readProfileApps(target)
    try {
      writeFileSync(
        marker,
        `${JSON.stringify({ signature, overrides, apps, syncedAt: new Date().toISOString() }, null, 2)}\n`,
        { mode: 0o600 },
      )
    } catch {
      // The marker is an optimisation; the mirror itself is the deliverable.
    }
    logger.info?.(
      `dsh-multi-user: ${hostChanged ? 'mirrored' : 're-patched'} profiles/${config.profile} `
      + `for ${user.username} (${copied.length} entries, ${apps.length} app(s)`
      + `${overrides === '' ? '' : `, overrides ${overrides}`})`,
    )
    return { synced: true, changed: true, signature, overrides, apps, files: copied, patchApplied, links }
  }

  /**
   * Write the managed override block into a profile patch file.
   *
   * An empty `block` removes the block and falls back to the stock empty list.
   * Returns whether the file is left holding exactly the block we asked for —
   * `false` means the write failed, which the caller reports rather than hides.
   */
  function applyManagedPatch(patchFile, block, username) {
    let existing = ''
    try {
      existing = readFileSync(patchFile, 'utf8')
    } catch {
      // a brand-new profile has no patch file yet
    }
    const merged = mergePatchBlock(existing, block)
    if (merged === existing) return existing.includes(PATCH_BLOCK_START) === (block.trim().length > 0)
    if (countEmptyLists(merged) > 1) {
      // Never trade a stale override for an unbootable profile: refuse and say so.
      logger.warn?.(
        `dsh-multi-user: refusing to write ${patchFile} for ${username} — the result would hold `
        + 'two top-level empty lists, which stops the account\'s instance from booting',
      )
      return false
    }
    try {
      writeFileSync(patchFile, merged, { mode: 0o600 })
      return true
    } catch (error) {
      logger.warn?.(
        `dsh-multi-user: could not write the per-account patch for ${username} `
        + `(${patchFile}): ${error.message}`,
      )
      return false
    }
  }

  /** Render the administrator's per-account patch template for one user. */
  function renderUserPatch(user, home, workspace) {
    const slot = Number.isInteger(user.slot) ? user.slot : 0
    const values = {
      '{username}': user.username,
      '{home}': home,
      '{workspace}': workspace,
      '{port}': Number.isInteger(user.port) && user.port > 0 ? String(user.port) : '',
      '{slot}': String(slot),
      '{sidecarPort}': String(config.sidecarPortBase + slot),
    }
    let text = String(config.userProfilePatch ?? '')
    for (const [token, value] of Object.entries(values)) text = text.split(token).join(value)
    // Ordinary accounts compose no administrator-only surface (model
    // configuration, browser terminal). The administrator keeps both; see
    // NON_ADMIN_PATCH_ROWS for what this does and does not remove.
    if (!isAdministrator(user)) text = `${text.trimEnd()}\n${NON_ADMIN_PATCH_ROWS}\n`
    return text
  }

  /**
   * Merge our managed block into a profile patch file.
   *
   * The user's own entries are preserved; only the fenced block is replaced.
   * A stock file is `[]` — an empty YAML list — which cannot be appended to
   * directly (that would be invalid YAML), so it is swapped out for the block.
   * An empty `block` means "declare nothing": our fence is removed. In every
   * branch the result is normalised to *at most one* top-level empty list,
   * because two `[]` lines parse as two YAML documents and stop the account's
   * instance from ever booting. That normalisation is what repairs a profile a
   * buggy earlier build left holding duplicate empty lists.
   */
  function mergePatchBlock(existing, block) {
    const fenceRe = new RegExp(
      `${escapeRegExp(PATCH_BLOCK_START)}[\\s\\S]*?${escapeRegExp(PATCH_BLOCK_END)}\\n?`,
      'g',
    )
    const text = String(existing ?? '')
    const stripped = text.replace(fenceRe, '')
    if (String(block ?? '').trim().length === 0) {
      // Drop every bare top-level `[]` so we never leave a second one behind.
      const withoutLists = stripped
        .split('\n')
        .filter((line) => line.trim() !== '[]')
        .join('\n')
      if (hasPatchContent(withoutLists)) return `${withoutLists.trimEnd()}\n`
      const comments = withoutLists.trim()
      return comments.length > 0 ? `${comments}\n[]\n` : '[]\n'
    }
    const head = hasPatchContent(stripped) ? `${stripped.trimEnd()}\n\n` : ''
    return `${head}${PATCH_BLOCK_START}\n${block.trimEnd()}\n${PATCH_BLOCK_END}\n`
  }

  /**
   * The shape a profile patch file must always have: at most one top-level
   * empty list. A second `[]` turns the file into two YAML documents and every
   * account on the host fails to boot, so this is checked before every write.
   */
  function countEmptyLists(text) {
    return String(text ?? '')
      .split('\n')
      .filter((line) => line.trim() === '[]')
      .length
  }

  /**
   * Create the administrator-declared symlinks inside a user home.
   *
   * This is how read-only bulk (LLM weights, a Python venv) is shared between
   * accounts without duplicating gigabytes per user. Existing paths are never
   * clobbered, so a user who replaced a link with real content keeps it.
   */
  function linkSeedPaths(user, home) {
    const created = []
    for (const [relative, target] of Object.entries(config.userSeedLinks ?? {})) {
      if (typeof relative !== 'string' || typeof target !== 'string') continue
      if (relative.length === 0 || target.length === 0) continue
      const source = join(home, relative)
      if (existsSync(source)) continue
      if (!existsSync(target)) {
        logger.warn?.(`dsh-multi-user: not linking ${relative} for ${user.username} — ${target} does not exist`)
        continue
      }
      try {
        mkdirSync(dirname(source), { recursive: true, mode: 0o700 })
        symlinkSync(target, source)
        created.push(relative)
      } catch (error) {
        logger.warn?.(`dsh-multi-user: could not link ${relative} for ${user.username}: ${error.message}`)
      }
    }
    return created
  }

  /** Which command line actually launches `dsh`. */
  function resolveLauncher() {
    const bin = config.dshBin ?? 'pnpm'
    const args = Array.isArray(config.dshArgs) && config.dshArgs.length > 0
      ? [...config.dshArgs]
      : bin.endsWith('pnpm')
        ? ['dsh']
        : []
    return { bin, args }
  }

  /** Build the child environment: isolated home, isolated token, no recursion. */
  function childEnv(user, token) {
    const env = { ...process.env }
    env.DSH_HOME = homeOf(user)
    env.DSH_WEB_TOKEN = token
    env.HOME = env.HOME ?? process.env.HOME ?? ''
    // Recursion guard: a per-user instance must never mount the gateway again.
    env.DSH_MU_DISABLED = '1'
    delete env.DSH_MU_LISTEN_PORT
    return env
  }

  /** Spawn one instance and wait for it to answer. */
  async function start(user) {
    const { home, workspace } = ensureSpace(user)
    // Register an in-flight placeholder SYNCHRONOUSLY, before any await, so a
    // concurrent acquire() for the same account waits on this record instead of
    // launching a second child. 0.1.6 boots slower, which widened this race:
    // two children collided on the port, one died, and the gateway was left
    // pointing at a dead instance (502/503 on the user workspace).
    const record = {
      username: user.username,
      port: undefined,
      token: undefined,
      child: undefined,
      logPath: join(config.logDir, `${user.username}.log`),
      home,
      workspace,
      startedAt: Date.now(),
      lastUsed: Date.now(),
      cookie: undefined,
      ready: false,
      lastError: null,
    }
    instances.set(user.username, record)
    try {
      // Allocate the instance port BEFORE patching the profile so the
      // userProfilePatch {port} placeholder renders to the real port. 0.1.6+
      // ignores the CLI --port, so the profile's webserver.port must carry it.
      const port = Number.isInteger(user.port) && user.port > 0
        ? user.port
        : await allocatePort(config.portBase, config.portScanRange)
      user = { ...user, port }
      record.port = port
      // Bring the account's application set level with the host before booting.
      if (config.syncProfileOnStart) await syncProfile(user)
      // Ordinary accounts use the administrator's models; see syncAdminModels.
      if (config.inheritAdminModels !== false) syncAdminModels(user, home)
      const token = randomBytes(24).toString('base64url')
      record.token = token
      if (user.homeDir !== home || user.workspaceDir !== workspace) {
        // Persist the resolved paths so an operator can find the data later.
        deps.persistPaths?.(user.username, { homeDir: home, workspaceDir: workspace, port })
      }

      const logFd = openSync(record.logPath, 'a')
      const { bin, args } = resolveLauncher()
      const argv = [...args, 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open']

      logger.info?.(`dsh-multi-user: starting instance for ${user.username} on 127.0.0.1:${port} (DSH_HOME=${home})`)

      let child
      try {
        child = spawn(bin, argv, {
          cwd: config.dshRoot,
          env: childEnv(user, token),
          detached: true,
          stdio: ['ignore', logFd, logFd],
        })
      } catch (error) {
        throw new Error(`dsh-multi-user: could not launch ${bin} ${argv.join(' ')}: ${error.message}`)
      }
      child.unref()
      record.child = child

      const spawnFailure = new Promise((_, rejectPromise) => {
        child.once('error', (error) => rejectPromise(new Error(`dsh-multi-user: ${bin} failed to start: ${error.message}`)))
        child.once('exit', (code, signal) => {
          if (record.ready) return
          rejectPromise(new Error(
            `dsh-multi-user: instance for ${user.username} exited during startup `
            + `(code ${code}${signal === null ? '' : `, signal ${signal}`}); see ${record.logPath}`,
          ))
        })
      })

      const ready = (async () => {
        const deadline = Date.now() + config.startTimeoutSeconds * 1000
        for (;;) {
          if (Date.now() > deadline) {
            throw new Error(
              `dsh-multi-user: instance for ${user.username} did not answer within ${config.startTimeoutSeconds}s; see ${record.logPath}`,
            )
          }
          // eslint-disable-next-line no-await-in-loop -- readiness is a poll loop
          const result = await exchangeToken(port, token)
          if (result.cookie !== undefined) {
            record.cookie = result.cookie
            record.ready = true
            logger.info?.(`dsh-multi-user: instance for ${user.username} ready on 127.0.0.1:${port}`)
            return record
          }
          // eslint-disable-next-line no-await-in-loop -- readiness is a poll loop
          await new Promise((resolvePromise) => setTimeout(resolvePromise, READY_POLL_MS))
        }
      })()

      return await Promise.race([ready, spawnFailure])
    } catch (error) {
      record.lastError = error.message
      killRecord(record)
      // Remove only OUR record: a newer attempt may already have replaced it.
      if (instances.get(user.username) === record) instances.delete(user.username)
      throw error
    }
  }

  function killRecord(record, signal = 'SIGTERM') {
    const child = record?.child
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
    try {
      // Detached children lead their own process group; kill the group so the
      // `pnpm -> node -> tsx` chain dies together rather than orphaned.
      process.kill(-child.pid, signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        // already gone
      }
    }
  }

  async function reap() {
    if (stopped) return
    const ttl = config.idleTimeoutMinutes * 60 * 1000
    const now = Date.now()
    for (const [username, record] of [...instances]) {
      if (record.ready && now - record.lastUsed > ttl) {
        logger.info?.(`dsh-multi-user: reaping idle instance for ${username}`)
        killRecord(record)
        instances.delete(username)
      }
    }
  }

  const api = {
    /**
     * Resolve the upstream instance for a user, starting it when necessary.
     * @param user - the account record (needs `username`, optionally `homeDir`).
     * @returns `{ port, cookie, hostMode }`.
     */
    async acquire(user) {
      if (stopped) throw new Error('dsh-multi-user: gateway is shutting down')
      if (user.homeMode === 'host' && config.adminHomeMode === 'host') {
        const port = deps.hostPort?.()
        if (!Number.isInteger(port) || port <= 0) {
          throw new Error(
            'dsh-multi-user: adminHomeMode is "host" but the host DSH web port is unknown yet; retry in a moment',
          )
        }
        const cookie = deps.hostCookie ? await deps.hostCookie() : undefined
        return { port, cookie, hostMode: true }
      }
      const existing = instances.get(user.username)
      if (existing !== undefined && existing.ready) {
        // The host may have gained or lost an application since this instance
        // started. That set is fixed at boot, so mirroring it costs a restart.
        if (config.syncProfileOnStart && (await syncProfile({ ...user, port: existing.port })).changed === true) {
          logger.info?.(`dsh-multi-user: application set changed for ${user.username}; restarting its instance`)
          killRecord(existing)
          instances.delete(user.username)
          const restarted = await start(user)
          return { port: restarted.port, cookie: restarted.cookie, hostMode: false }
        }
        // The inherited model catalogue is different: the instance hot-reloads
        // its own settings.yaml, so mirroring it is just a file write. See
        // CATALOGUE_RECHECK_MS for the measurement behind that.
        if (config.inheritAdminModels !== false) refreshAdminModels(user)
        existing.lastUsed = Date.now()
        return { port: existing.port, cookie: existing.cookie, hostMode: false }
      }
      if (existing !== undefined && !existing.ready) {
        // A concurrent request already triggered startup; wait for that one.
        while (!existing.ready) {
          // eslint-disable-next-line no-await-in-loop -- waiting on a shared startup
          await new Promise((resolvePromise) => setTimeout(resolvePromise, READY_POLL_MS))
          if (!instances.has(user.username)) {
            throw new Error(`dsh-multi-user: instance for ${user.username} failed to start`)
          }
        }
        existing.lastUsed = Date.now()
        return { port: existing.port, cookie: existing.cookie, hostMode: false }
      }
      const record = await start(user)
      return { port: record.port, cookie: record.cookie, hostMode: false }
    },

    /** Stop one user's instance (used when the account is disabled or deleted). */
    stop(username) {
      const record = instances.get(username)
      if (record === undefined) return false
      killRecord(record)
      instances.delete(username)
      return true
    },

    /** Stop every managed instance (plugin dispose). */
    async stopAll() {
      stopped = true
      if (reaper !== null) clearInterval(reaper)
      for (const record of instances.values()) killRecord(record)
      instances.clear()
    },

    /** Live instance table for the admin console. */
    status() {
      return [...instances.values()].map((record) => ({
        username: record.username,
        port: record.port,
        homeDir: record.home,
        workspaceDir: record.workspace,
        startedAt: new Date(record.startedAt).toISOString(),
        lastUsedAt: new Date(record.lastUsed).toISOString(),
        idleMs: Date.now() - record.lastUsed,
        alive: record.child.exitCode === null && record.child.signalCode === null,
        logPath: record.logPath,
      }))
    },

    homeOf,
    workspaceOf,
    ensureSpace,
    seedUserHome,
    syncProfile,
    /** The application set the host profile currently advertises. */
    hostApps() {
      const hostHome = deps.hostHome?.()
      if (typeof hostHome !== 'string' || hostHome.length === 0) return []
      return readProfileApps(join(hostHome, 'profiles', config.profile))
    },
    /** Profile inheritance configuration, for the console and diagnostics. */
    profileInfo() {
      return { inheritProfile: config.inheritProfile, profile: config.profile, syncOnStart: config.syncProfileOnStart }
    },
    /** Expose the resolved launcher for diagnostics. */
    launcher: resolveLauncher,
    /** Directory holding one user's data. */
    dataDirOf(username) {
      return join(config.usersDir, username)
    },
  }

  return api
}

/** Prepend the launcher's own directory to PATH so its child tools resolve. */
export function withLauncherPath(env, bin) {
  if (typeof bin !== 'string' || bin.includes('/')) {
    const dir = bin === undefined ? '' : dirname(bin)
    if (dir.length === 0) return env
    return { ...env, PATH: `${dir}${delimiter}${env.PATH ?? ''}` }
  }
  return env
}
