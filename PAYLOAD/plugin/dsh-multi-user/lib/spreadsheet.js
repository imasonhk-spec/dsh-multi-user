/**
 * dsh-multi-user — spreadsheet support for bulk account import.
 *
 * The plugin ships with no npm dependencies and no build step, so "let the
 * administrator import accounts from Excel" cannot mean "pull in a parser".
 * Everything here is therefore written against `node:zlib` alone:
 *
 *   - {@link buildUserTemplate} writes a real `.xlsx` workbook (ZIP + OOXML)
 *     an operator can fill in with Excel or WPS;
 *   - {@link readUserTable} reads one back — `.xlsx`/`.xlsm`, or a `.csv`/`.tsv`
 *     export, including the GBK/UTF-16 encodings a Chinese Windows Excel
 *     produces by default.
 *
 * {@link readUserTable} is deliberately tolerant about layout: a header row is
 * recognised by column *name* (several aliases each), so re-ordering columns or
 * renaming 备注 to 说明 keeps working; a table with no recognisable header falls
 * back to the legacy positional layout (`用户名,密码,角色,备注`).
 *
 * @module dsh-multi-user/spreadsheet
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib'

// ── tiny ZIP writer / reader ─────────────────────────────────────────────────
// Enough of the format for an OOXML package: one local header per member, a
// central directory, an end-of-central-directory record. No data descriptors,
// no ZIP64 — a user roster is never anywhere near 4 GiB.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** MS-DOS packed timestamp, which is what a ZIP header stores. */
function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff,
    date: (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff,
  }
}

/** Build a ZIP archive from `[{ name, data }]`. */
function zipArchive(entries) {
  const stamp = dosDateTime()
  const chunks = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8')
    const deflated = deflateRawSync(raw, { level: 9 })
    const compress = deflated.length < raw.length
    const payload = compress ? deflated : raw
    const method = compress ? 8 : 0
    const crc = crc32(raw)

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // file name is UTF-8
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)
    chunks.push(local, payload)

    const directory = Buffer.alloc(46 + name.length)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(0x0800, 8)
    directory.writeUInt16LE(method, 10)
    directory.writeUInt16LE(stamp.time, 12)
    directory.writeUInt16LE(stamp.date, 14)
    directory.writeUInt32LE(crc, 16)
    directory.writeUInt32LE(payload.length, 20)
    directory.writeUInt32LE(raw.length, 24)
    directory.writeUInt16LE(name.length, 28)
    directory.writeUInt16LE(0, 30)
    directory.writeUInt16LE(0, 32)
    directory.writeUInt16LE(0, 34)
    directory.writeUInt16LE(0, 36)
    directory.writeUInt32LE(0, 38)
    directory.writeUInt32LE(offset, 42)
    name.copy(directory, 46)
    central.push(directory)

    offset += local.length + payload.length
  }

  const directoryBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directoryBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, directoryBuffer, end])
}

function findEndOfCentralDirectory(buffer) {
  const lowest = Math.max(0, buffer.length - 0xffff - 22)
  for (let at = buffer.length - 22; at >= lowest; at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) return at
  }
  return -1
}

/** Open a ZIP archive; returns `{ names, read(name) }`. */
function unzipArchive(buffer) {
  const end = findEndOfCentralDirectory(buffer)
  if (end === -1) throw new Error('不是有效的 Excel 文件（未找到 ZIP 结构）')
  const count = buffer.readUInt16LE(end + 10)
  const directoryAt = buffer.readUInt32LE(end + 16)

  const members = new Map()
  let cursor = directoryAt
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) break
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localAt = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    members.set(name, { method, compressedSize, localAt })
    cursor += 46 + nameLength + extraLength + commentLength
  }

  return {
    names: [...members.keys()],
    read(name) {
      const entry = members.get(name)
      if (entry === undefined) return undefined
      const nameLength = buffer.readUInt16LE(entry.localAt + 26)
      const extraLength = buffer.readUInt16LE(entry.localAt + 28)
      const from = entry.localAt + 30 + nameLength + extraLength
      const raw = buffer.subarray(from, from + entry.compressedSize)
      if (entry.method === 0) return Buffer.from(raw)
      if (entry.method === 8) return inflateRawSync(raw)
      throw new Error(`工作簿使用了不支持的压缩方式（${entry.method}）`)
    },
  }
}

// ── XML helpers ──────────────────────────────────────────────────────────────

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }

function decodeXml(value) {
  return String(value).replace(/&(#[xX]?[0-9A-Fa-f]+|[A-Za-z]+);/g, (match, entity) => {
    try {
      if (entity[0] === '#') {
        const hex = entity[1] === 'x' || entity[1] === 'X'
        const code = Number.parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : match
      }
      return NAMED_ENTITIES[entity] ?? match
    } catch {
      return match
    }
  })
}

function encodeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[character]))
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** `B7` -> 1 (zero-based column index); `-1` when the ref is unusable. */
function columnIndexOf(ref) {
  const letters = /^([A-Za-z]+)/.exec(String(ref ?? ''))?.[1]
  if (letters === undefined) return -1
  let index = 0
  for (const character of letters.toUpperCase()) {
    index = index * 26 + (character.charCodeAt(0) - 64)
  }
  return index - 1
}

/** 1 -> `B` (zero-based column index to letters). */
function columnNameOf(index) {
  let value = index + 1
  let out = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    out = LETTERS[remainder] + out
    value = Math.floor((value - 1) / 26)
  }
  return out
}

/** Concatenate every `<t>` run inside a fragment (rich text aware). */
function textRuns(fragment) {
  let out = ''
  for (const match of fragment.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += decodeXml(match[1])
  if (out.length > 0) return out
  const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(fragment)
  return value === null ? '' : decodeXml(value[1])
}

// ── reading ──────────────────────────────────────────────────────────────────

/** Resolve the first worksheet part of a workbook, via its relationship graph. */
function resolveFirstSheet(archive) {
  const workbook = archive.read('xl/workbook.xml')?.toString('utf8') ?? ''
  const relationships = archive.read('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? ''

  const targetById = new Map()
  for (const match of relationships.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = /\bId="([^"]*)"/.exec(match[0])?.[1]
    const target = /\bTarget="([^"]*)"/.exec(match[0])?.[1]
    if (id !== undefined && target !== undefined) targetById.set(id, target)
  }

  for (const match of workbook.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const id = /\br:id="([^"]*)"/.exec(match[0])?.[1]
    const rawName = /\bname="([^"]*)"/.exec(match[0])?.[1]
    const target = id === undefined ? undefined : targetById.get(id)
    if (target === undefined) continue
    const path = target.startsWith('/')
      ? target.slice(1)
      : `xl/${target.replace(/^\.\//, '')}`
    const normalized = path.replace(/\/{2,}/g, '/')
    if (archive.names.includes(normalized)) {
      return { path: normalized, name: rawName === undefined ? undefined : decodeXml(rawName) }
    }
  }

  const fallback = archive.names.find((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
  if (fallback === undefined) throw new Error('工作簿里没有可读的工作表')
  return { path: fallback, name: undefined }
}

/** Parse one worksheet into `[{ rowNumber, cells }]`, cells being sparse arrays. */
function parseWorksheet(xml, sharedStrings) {
  const rows = []
  for (const rowMatch of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const declared = /\br="(\d+)"/.exec(rowMatch[0])
    const rowNumber = declared === null ? rows.length + 1 : Number(declared[1])
    const cells = []
    let cursor = -1
    for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cellMatch[1]
      const body = cellMatch[2] ?? ''
      const ref = /\br="([A-Za-z]+\d+)"/.exec(attributes)
      const at = ref === null ? cursor + 1 : columnIndexOf(ref[1])
      if (at < 0) continue
      cursor = at
      const type = /\bt="([^"]+)"/.exec(attributes)?.[1] ?? 'n'
      if (type === 'inlineStr') {
        cells[at] = textRuns(body)
      } else if (type === 's') {
        const index = Number(textRuns(body))
        cells[at] = Number.isInteger(index) && index >= 0 && index < sharedStrings.length
          ? sharedStrings[index]
          : textRuns(body)
      } else {
        cells[at] = textRuns(body)
      }
    }
    rows.push({ rowNumber, cells })
  }
  return rows
}

/** Read an `.xlsx`/`.xlsm` buffer into a table. */
export function readXlsx(buffer) {
  const archive = unzipArchive(buffer)

  const sharedStrings = []
  const sharedXml = archive.read('xl/sharedStrings.xml')?.toString('utf8')
  if (sharedXml !== undefined) {
    for (const match of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      sharedStrings.push(textRuns(match[1]))
    }
  }

  const sheet = resolveFirstSheet(archive)
  const sheetXml = archive.read(sheet.path)?.toString('utf8')
  if (sheetXml === undefined) throw new Error('工作簿里没有可读的工作表')
  return { sheetName: sheet.name ?? null, rows: parseWorksheet(sheetXml, sharedStrings) }
}

/** Excel on a Chinese Windows box writes GBK or UTF-16 by default. */
function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer)
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer)
  }
  const utf8 = buffer.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  for (const encoding of ['gb18030', 'gbk', 'big5']) {
    try {
      const decoded = new TextDecoder(encoding).decode(buffer)
      if (!decoded.includes('\uFFFD')) return decoded
    } catch {
      // Encoding missing from this Node build — try the next candidate.
    }
  }
  return utf8
}

/** Pick the field separator from the first line, ignoring quoted regions. */
function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const counts = new Map([['\t', 0], [';', 0], [',', 0]])
  let quoted = false
  for (const character of firstLine) {
    if (character === '"') quoted = !quoted
    else if (!quoted && counts.has(character)) counts.set(character, counts.get(character) + 1)
  }
  let best = ','
  for (const [character, count] of counts) {
    if (count > (counts.get(best) ?? 0)) best = character
  }
  return best
}

function parseDelimited(text, delimiter) {
  const rows = []
  let cells = []
  let field = ''
  let quoted = false
  let index = 0

  while (index < text.length) {
    const character = text[index]
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        quoted = false
        index += 1
        continue
      }
      field += character
      index += 1
      continue
    }
    if (character === '"' && field.length === 0) {
      quoted = true
      index += 1
      continue
    }
    if (character === delimiter) {
      cells.push(field)
      field = ''
      index += 1
      continue
    }
    if (character === '\r') {
      index += 1
      continue
    }
    if (character === '\n') {
      cells.push(field)
      rows.push({ rowNumber: rows.length + 1, cells })
      cells = []
      field = ''
      index += 1
      continue
    }
    field += character
    index += 1
  }
  cells.push(field)
  rows.push({ rowNumber: rows.length + 1, cells })
  return rows
}

// ── column mapping ───────────────────────────────────────────────────────────

/** Column names an operator might reasonably use for each field. */
const COLUMN_ALIASES = {
  username: ['用户名', '用户', '账号', '帐号', '登录名', '登录账号', 'username', 'user name', 'user', 'name', 'account', 'login', 'loginname'],
  password: ['密码', '初始密码', '登录密码', 'password', 'passwd', 'pass', 'pwd'],
  role: ['角色', '用户角色', '身份', '权限', 'role', 'userrole'],
  status: ['状态', '账号状态', 'status', 'state', 'enabled'],
  note: ['备注', '说明', '描述', '注释', 'note', 'notes', 'remark', 'remarks', 'comment', 'memo', 'description', '部门', 'dept'],
}

const FIELDS = Object.keys(COLUMN_ALIASES)

/**
 * Aliases that are also plausible *data*. A header-less CSV whose first row is
 * `alice,pw1,user,研发部` must not be mistaken for a header just because the
 * word `user` happens to be a column alias — so a lone weak match is ignored.
 */
const WEAK_ALIASES = new Set(['user', 'name', 'account', 'login', 'loginname', 'user name', 'state', 'enabled', 'pass', 'dept'])

/** `用户名 *（必填）` -> `用户名`; `Password:` -> `password`. */
function normalizeHeader(value) {
  return String(value ?? '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[*＊]/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[:：].*$/, '')
    .toLowerCase()
}

/** Map header cells to field indexes. Exact names win over decorated ones. */
function mapHeader(cells) {
  const normalized = cells.map(normalizeHeader)
  const columns = {}
  const claimed = new Set()

  normalized.forEach((name, at) => {
    if (name.length === 0) return
    for (const field of FIELDS) {
      if (claimed.has(field)) continue
      if (COLUMN_ALIASES[field].includes(name)) {
        columns[field] = at
        claimed.add(field)
        return
      }
    }
  })

  // Second pass for headers carrying extra words ("密码 Password", "用户账号").
  let bestField = null
  let bestAt = -1
  let bestLength = 0
  for (const field of FIELDS) {
    if (claimed.has(field)) continue
    normalized.forEach((name, at) => {
      for (const alias of COLUMN_ALIASES[field]) {
        if (alias.length > name.length) continue
        if (name.startsWith(alias) && alias.length > bestLength) {
          bestField = field
          bestAt = at
          bestLength = alias.length
        }
      }
    })
    if (bestField === field) {
      columns[field] = bestAt
      claimed.add(field)
      bestField = null
      bestAt = -1
      bestLength = 0
    }
  }

  return columns
}

/**
 * Turn a worksheet / delimited table into import records.
 *
 * @param rows - `[{ rowNumber, cells }]`.
 * @param format - `'xlsx'` or `'csv'`, reported back to the operator.
 * @param sheetName - worksheet name, when known.
 */
function toRecords(rows, format, sheetName) {
  const firstAt = rows.findIndex((row) => row.cells.some((cell) => String(cell ?? '').trim().length > 0))
  const first = firstAt === -1 ? undefined : rows[firstAt]
  const columns = first === undefined ? {} : mapHeader(first.cells)
  // A header row is only believed when it maps the username column *and* either
  // maps something else or names it unambiguously (`用户名`/`username`, not the
  // bare word `user`, which is far more likely to be a value).
  const usernameAlias = columns.username === undefined
    ? ''
    : normalizeHeader(first.cells[columns.username])
  const headerUsed = columns.username !== undefined
    && (Object.keys(columns).length >= 2 || !WEAK_ALIASES.has(usernameAlias))

  // No recognisable header: fall back to the legacy positional layout
  // (`用户名,密码,角色,备注`) so a plain export still imports.
  const layout = headerUsed
    ? columns
    : { username: 0, password: 1, role: 2, note: 3 }

  const records = []
  let skippedRows = 0

  for (const [index, row] of rows.entries()) {
    if (headerUsed && index === firstAt) continue
    const cells = row.cells.map((cell) => String(cell ?? '').trim())
    const rowNumber = Number.isInteger(row.rowNumber) ? row.rowNumber : index + 1
    if (cells.every((cell) => cell.length === 0) || cells[0].startsWith('#')) {
      skippedRows += 1
      continue
    }
    const at = (field) => (layout[field] === undefined ? '' : (cells[layout[field]] ?? ''))
    const record = {
      line: rowNumber,
      username: at('username'),
      password: at('password'),
      role: at('role'),
      status: at('status'),
      note: at('note'),
    }
    record.input = [record.username, record.password, record.role, record.note]
      .filter((value) => value.length > 0)
      .join(',')
      .slice(0, 160)
    records.push(record)
  }

  return {
    format,
    sheetName: sheetName ?? null,
    headerUsed,
    headers: first === undefined ? [] : first.cells.map((cell) => String(cell ?? '').trim()),
    rows: rows.length,
    skippedRows,
    records,
  }
}

/** Upper bound on imported rows: a typo must not queue 50 000 accounts. */
export const MAX_IMPORT_ROWS = 2000

/**
 * Read an uploaded spreadsheet into import records.
 *
 * @param buffer - the raw upload.
 * @param filename - used only to reject legacy `.xls` with a helpful message.
 * @returns `{ format, sheetName, headers, rows, skippedRows, records }`.
 */
export function readUserTable(buffer, filename = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('上传内容为空')
  const lower = String(filename).toLowerCase()
  const zip = buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4b

  let table
  if (zip) {
    const { sheetName, rows } = readXlsx(buffer)
    table = toRecords(rows, 'xlsx', sheetName)
  } else {
    if (lower.endsWith('.xls')) {
      throw new Error('不支持旧版 .xls（二进制格式），请用 Excel / WPS 另存为 .xlsx 或 CSV 后再导入')
    }
    const text = decodeText(buffer).replace(/^\uFEFF/, '')
    if (text.trim().length === 0) throw new Error('文件里没有可读内容')
    table = toRecords(parseDelimited(text, detectDelimiter(text)), 'csv', null)
  }

  if (table.records.length > MAX_IMPORT_ROWS) {
    throw new Error(`一次最多导入 ${MAX_IMPORT_ROWS} 个账号，当前文件有 ${table.records.length} 行`)
  }
  return table
}

// ── template ─────────────────────────────────────────────────────────────────

/** The data sheet's columns, in the order the template presents them. */
export const TEMPLATE_COLUMNS = ['用户名 *', '密码', '角色', '状态', '备注']

const TEMPLATE_ROWS = [
  TEMPLATE_COLUMNS,
  ['alice', 'Passw0rd123', 'user', 'active', '研发部'],
  ['bob', '', 'user', 'active', '密码留空，导入时自动生成'],
  ['carol', 'Carol@2026', 'user', 'disabled', '试用账号（暂不启用）'],
]

const GUIDE_ROWS = [
  ['说明项', '内容'],
  ['用户名', '必填。只能是字母、数字、点、下划线和短横线（1–32 位，须以字母或数字开头）。'],
  ['密码', '留空则自动生成 14 位强密码；导入结果里只显示一次，请及时保存。'],
  ['角色', 'user（普通用户）或 admin（管理员）。留空默认 user。'],
  ['状态', 'active（启用）或 disabled（禁用）。留空默认 active。'],
  ['备注', '可选，任意文字，仅用于管理员备注。'],
  ['表头行', '第 1 行必须是表头。列顺序可以调换——按列名识别；没有可识别表头时按 A=用户名 B=密码 C=角色 D=备注 解析。'],
  ['数据行', '从第 2 行开始，一行一个账号。空行、以 # 开头的行会被忽略。'],
  ['重复用户名', '由导入页面的「用户名已存在时」决定：跳过（保留原账号）或更新（改角色/状态/备注，密码非空则重置）。'],
  ['密码列格式', '已设为文本格式，避免以 0 开头的密码丢失前导零；请不要把该列改成数字或常规格式。'],
  ['工作表', '导入时只读取第 1 个工作表，请把账号填在本「用户」表里。'],
  ['支持的文件', '.xlsx / .xlsm / .csv / .tsv。旧版 .xls 请先另存为 .xlsx 或 CSV。'],
  ['单次上限', `一次最多导入 ${MAX_IMPORT_ROWS} 个账号。`],
]

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

/**
 * Serialize one worksheet.
 *
 * @param rows - array of arrays of strings; `''`/null cells are left sparse.
 * @param options - `{ widths, textColumns, validations }`.
 *   `textColumns` are written with the built-in `@` number format so Excel
 *   keeps leading zeros in passwords typed below them.
 */
function worksheetXml(rows, options = {}) {
  const { widths = [], textColumns = [], validations = [] } = options
  const lastColumn = columnNameOf(Math.max(0, ...rows.map((row) => row.length - 1)))
  const dimension = `A1:${lastColumn}${Math.max(1, rows.length)}`

  const cols = widths.length === 0 ? '' : `<cols>${widths
    .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`)
    .join('')}</cols>`

  const sheetData = rows.map((cells, rowIndex) => {
    const rowNumber = rowIndex + 1
    const parts = cells.map((value, columnIndex) => {
      const text = value === null || value === undefined ? '' : String(value)
      if (text.length === 0) return ''
      const style = rowIndex === 0 ? 1 : (textColumns.includes(columnIndex) ? 2 : 0)
      const ref = `${columnNameOf(columnIndex)}${rowNumber}`
      return `<c r="${ref}"${style === 0 ? '' : ` s="${style}"`} t="inlineStr"><is><t xml:space="preserve">${encodeXml(text)}</t></is></c>`
    }).join('')
    return `<row r="${rowNumber}">${parts}</row>`
  }).join('')

  const validation = validations.length === 0 ? '' : `<dataValidations count="${validations.length}">${validations
    .map((item) => `<dataValidation type="list" allowBlank="1" sqref="${item.range}"><formula1>"${encodeXml(item.values.join(','))}"</formula1></dataValidation>`)
    .join('')}</dataValidations>`

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dimension}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${sheetData}</sheetData>${validation}</worksheet>`
}

/**
 * Build the import template workbook.
 *
 * Sheet 1 (`用户`) is the data sheet — it is the only one the importer reads —
 * and sheet 2 (`填写说明`) documents every column.
 *
 * @returns a `Buffer` holding a valid `.xlsx`.
 */
export function buildUserTemplate() {
  const data = worksheetXml(TEMPLATE_ROWS, {
    widths: [22, 22, 12, 12, 34],
    textColumns: [0, 1],
    validations: [
      { range: 'C2:C400', values: ['user', 'admin'] },
      { range: 'D2:D400', values: ['active', 'disabled'] },
    ],
  })
  const guide = worksheetXml(GUIDE_ROWS, { widths: [16, 96] })

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="用户" sheetId="1" r:id="rId1"/><sheet name="填写说明" sheetId="2" r:id="rId2"/></sheets></workbook>`

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`

  return zipArchive([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: STYLES_XML },
    { name: 'xl/worksheets/sheet1.xml', data: data },
    { name: 'xl/worksheets/sheet2.xml', data: guide },
  ])
}

/** The same template as UTF-8 CSV, for operators who prefer a text editor. */
export function buildUserTemplateCsv() {
  const rows = [
    '用户名,密码,角色,状态,备注',
    'alice,Passw0rd123,user,active,研发部',
    'bob,,user,active,密码留空将自动生成',
    'carol,Carol@2026,user,disabled,试用账号（暂不启用）',
  ]
  return Buffer.from(`\uFEFF${rows.join('\r\n')}\r\n`, 'utf8')
}
