import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/**
 * Normalise a credentials document for a freshly seeded account home.
 *
 * WHY: `seedUserHome` copies the host's `.credentials.yaml` verbatim. If that
 * host document carries a credential record as a TOP-LEVEL key (observed value:
 * `client-connection/browser-session`), the new account's DSH instance fails to
 * boot, because `@deepseek-ai/dsh-credentials-local` accepts only the top-level
 * keys `refs`/`version`/`records` and resolves records as nested paths under
 * `records`. The gateway then answers 503 for that account forever.
 *
 * The seeded copy is therefore migrated to the nested shape. Returns the text
 * unchanged when there is nothing to migrate, so a clean host stays byte-stable
 * apart from key order.
 *
 * @param text - raw YAML of the host credentials document.
 * @returns normalised YAML text.
 */
export function normalizeCredentialsText(text) {
  const ALLOWED = ['refs', 'version', 'records']
  let doc
  try {
    doc = parseYaml(text)
  } catch {
    return text // leave an unparsable document exactly as-is; boot will report it
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return text
  const stray = Object.keys(doc).filter((key) => !ALLOWED.includes(key))
  if (stray.length === 0) return text
  const records = (doc.records !== null && typeof doc.records === 'object' && !Array.isArray(doc.records))
    ? { ...doc.records }
    : {}
  for (const key of stray) records[key] = doc[key]
  return stringifyYaml({ refs: doc.refs, version: doc.version, records }, { lineWidth: 0 })
}
