import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { CommandContext, Provider } from './types.js'
import type { Pasteboard } from './clipboard.js'
import { tr } from '../i18n.js'

const MESSAGES_DB = join(homedir(), 'Library', 'Messages', 'chat.db')
const APPLE_EPOCH_MS = 978_307_200_000
const WINDOW_MS = 5 * 60_000
const QUERY_LIMIT = 100
const COMMAND_TIMEOUT_MS = 2_500
// 100 rows can contain either 4 KiB of JSON-escaped text or 4 KiB of hex BLOB data.
// Keep the whole result bounded while allowing the full recent-message window through.
const MAX_QUERY_OUTPUT_BYTES = 3 * 1024 * 1024
const CODE_LENGTH = /^\d{4,8}$/
const MAX_ATTRIBUTED_BODY_BYTES = 4_096
const REQUEST_COOLDOWN_MS = 5_000
const RequestSchema = z.null()

// The code enters osascript only on stdin; the source is constant and no widget value is in argv.
// AppKit marks it concealed/transient and limits Universal Clipboard to this Mac. It prints only
// the pasteboard change count so a detached cleanup process can clear the code after one minute.
const WRITE_CODE_SCRIPT = `ObjC.import('AppKit');
ObjC.import('Foundation');
const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
const value = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
if (!value) throw new Error('invalid input');
const board = $.NSPasteboard.generalPasteboard;
const ownedChangeCount = Number(board.prepareForNewContentsWithOptions($.NSPasteboardContentsCurrentHostOnly));
if (!Number.isSafeInteger(ownedChangeCount)) throw new Error('pasteboard write failed');
if (!board.setStringForType(value, $.NSPasteboardTypeString)) throw new Error('pasteboard write failed');
if (!board.setDataForType($.NSData.data, 'org.nspasteboard.ConcealedType')) throw new Error('pasteboard write failed');
if (!board.setDataForType($.NSData.data, 'org.nspasteboard.TransientType')) throw new Error('pasteboard write failed');
if (Number(board.changeCount) !== ownedChangeCount) throw new Error('pasteboard write failed');
String(ownedChangeCount);`

const CLEAR_CODE_SCRIPT = `ObjC.import('AppKit');
ObjC.import('Foundation');
const args = $.NSProcessInfo.processInfo.arguments;
const expected = Number(ObjC.unwrap(args.lastObject));
$.NSThread.sleepForTimeInterval(60);
const board = $.NSPasteboard.generalPasteboard;
if (Number(board.changeCount) === expected) board.clearContents();`

type ScriptExecutor = (script: string, args: string[], stdin?: string) => Promise<string>
type CleanupSpawner = (changeCount: number) => ChildProcess

const executeAppleScript: ScriptExecutor = (script, args, stdin) => new Promise((resolve, reject) => {
  const child = execFile('osascript', ['-l', 'JavaScript', '-e', script, ...args], {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 1024,
    shell: false,
  }, (error, stdout) => {
    if (error) reject(new Error('pasteboard operation failed'))
    else resolve(stdout)
  })
  if (stdin !== undefined) child.stdin?.end(stdin)
})

const spawnCleanup: CleanupSpawner = (changeCount) => spawn('osascript', [
  '-l', 'JavaScript', '-e', CLEAR_CODE_SCRIPT, String(changeCount),
], { detached: true, stdio: 'ignore' })

function reportCleanupFailure(): void {
  console.error('Messages code pasteboard cleanup failed.')
}

export function createMessagePasteboardWriter(
  dependencies: { executeScript?: ScriptExecutor; spawnCleanup?: CleanupSpawner } = {},
): Pick<Pasteboard, 'write'> {
  const runScript = dependencies.executeScript ?? executeAppleScript
  const startCleanup = dependencies.spawnCleanup ?? spawnCleanup
  const clearIfUnchanged = async (changeCount: number): Promise<void> => {
    await runScript(CLEAR_IF_UNCHANGED_SCRIPT, [String(changeCount)])
  }

  return {
    write: async (text) => {
      const stdout = await runScript(WRITE_CODE_SCRIPT, [], text)
      const changeCount = Number(stdout.trim())
      if (!Number.isSafeInteger(changeCount)) throw new Error('pasteboard write failed')

      try {
        const cleanup = startCleanup(changeCount)
        await new Promise<void>((resolve, reject) => {
          let started = false
          cleanup.once('error', (error) => {
            if (!started) reject(error)
            else void clearIfUnchanged(changeCount).catch(reportCleanupFailure)
          })
          cleanup.once('spawn', () => {
            started = true
            cleanup.unref()
            resolve()
          })
          cleanup.once('exit', (code) => {
            if (code !== 0) void clearIfUnchanged(changeCount).catch(reportCleanupFailure)
          })
        })
      } catch {
        try { await clearIfUnchanged(changeCount) }
        catch { reportCleanupFailure() }
        throw new Error('pasteboard cleanup could not be started')
      }
    },
  }
}

const CLEAR_IF_UNCHANGED_SCRIPT = `ObjC.import('AppKit');
ObjC.import('Foundation');
const args = $.NSProcessInfo.processInfo.arguments;
const expected = Number(ObjC.unwrap(args.lastObject));
const board = $.NSPasteboard.generalPasteboard;
if (Number(board.changeCount) === expected) board.clearContents();`

const messagePasteboard: Pick<Pasteboard, 'write'> = createMessagePasteboardWriter()

interface MessageRow {
  text?: string
  attributedHex?: string
  date?: number | string
}

type Run = (file: string, args: string[]) => Promise<string>

interface Messages2FAOptions {
  databasePath?: string
  now?: () => number
  run?: Run
  pasteboard?: Pick<Pasteboard, 'write'>
  enabled?: () => boolean
}

const defaultRun: Run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_QUERY_OUTPUT_BYTES, shell: false }, (error, stdout) => {
    if (error) reject(new Error('Messages could not be read.'))
    else resolve(stdout)
  })
})

function timestampBounds(now: number): { appleSeconds: number; appleNanoseconds: number } {
  const cutoff = now - WINDOW_MS - APPLE_EPOCH_MS
  return { appleSeconds: Math.floor(cutoff / 1000), appleNanoseconds: Math.floor(cutoff * 1_000_000) }
}

function appleDateToUnixMs(value: unknown): number | undefined {
  const date = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(date) || date <= 0) return undefined
  const unixMs = date > 1_000_000_000_000
    ? date / 1_000_000 + APPLE_EPOCH_MS
    : date * 1000 + APPLE_EPOCH_MS
  return Number.isFinite(unixMs) ? unixMs : undefined
}

function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

function hasVerificationContext(text: string, start: number, end: number): boolean {
  const segmentStart = Math.max(text.lastIndexOf('.', start), text.lastIndexOf('!', start), text.lastIndexOf('?', start), text.lastIndexOf('\n', start), text.lastIndexOf('…', start)) + 1
  const boundaries = [text.indexOf('.', end), text.indexOf('!', end), text.indexOf('?', end), text.indexOf('\n', end), text.indexOf('…', end)].filter((i) => i >= 0)
  const segmentEnd = boundaries.length ? Math.min(...boundaries) : text.length
  const segment = normalize(text.slice(segmentStart, segmentEnd))
  const codeOffset = normalize(text.slice(segmentStart, start)).length
  const beforeCode = segment.slice(0, codeOffset)
  const context = segment
  if (/(?:account\s+)?(?:ending|ends?\s+in|ending\s+with|last\s+digits?|se\s+termine\s+par)\s*\S{0,18}$/i.test(beforeCode)) return false
  if (/\b\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b|\b\d{4}-\d{2}-\d{2}\b/.test(context)) {
    const dates = [...context.matchAll(/\b\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b|\b\d{4}-\d{2}-\d{2}\b/g)]
    if (dates.some((date) => date.index !== undefined && codeOffset >= date.index && codeOffset < date.index + date[0].length)) return false
  }
  const codeMarker = /\b(?:passcode|otp)\b|\byour\s+code\b|\bcode\s+is\s+your\b|\b(?:verification|security|authentication|authenticator|one[ -]?time)\s+code\b|\bcode\s+(?:de\s+)?(?:verification|security|connexion|securite|acces|confirmation)\b|\bcode\b.{0,18}\b(?:is|est)\b/
  return codeMarker.test(context)
}

function verificationCode(text: string): string | undefined {
  const pattern = /(?<!\d)\d{4,8}(?!\d)/g
  for (const match of text.matchAll(pattern)) {
    const code = match[0]
    const start = match.index
    if (start !== undefined && CODE_LENGTH.test(code) && hasVerificationContext(text, start, start + code.length)) {
      return code
    }
  }
  return undefined
}

function decodeTypedstreamAttributedBody(hex: string): string | undefined {
  if (hex.length === 0 || hex.length > MAX_ATTRIBUTED_BODY_BYTES * 2 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return undefined
  const bytes = Buffer.from(hex, 'hex')
  const isTypedstream = bytes.length >= 13 && bytes[0] === 4 && bytes[1] === 11 && bytes.subarray(2, 13).toString('ascii') === 'streamtyped'
  if (!isTypedstream) {
    // Keep compatibility with older/test databases that stored plain UTF-8 in attributedBody;
    // reject binary/control-heavy payloads rather than heuristically scraping them.
    try {
      const plain = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      return plain && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(plain) ? plain : undefined
    } catch {
      return undefined
    }
  }

  // Messages stores NSAttributedString bodies as NSArchiver typedstreams. The actual plaintext
  // is the unshared NSString value immediately following its class declaration. Parse its
  // length prefix as bytes; decoding the whole archive as SQLite TEXT stops at embedded NULs.
  const stringClass = Buffer.from('NSString', 'ascii')
  const classIndex = bytes.indexOf(stringClass, 13)
  if (classIndex < 0) return undefined
  const classEnd = classIndex + stringClass.length
  const markerIndex = bytes.indexOf(0x2b, classEnd)
  if (markerIndex < classEnd || markerIndex - classEnd > 32) return undefined

  let cursor = markerIndex + 1
  const tag = bytes[cursor++]
  let length: number
  if (tag <= 0x7f) length = tag
  else if (tag === 0x81 && cursor + 2 <= bytes.length) {
    length = bytes.readUInt16LE(cursor)
    cursor += 2
  } else if (tag === 0x82 && cursor + 4 <= bytes.length) {
    length = bytes.readUInt32LE(cursor)
    cursor += 4
  } else if (tag === 0x83 && cursor + 8 <= bytes.length) {
    const longLength = bytes.readBigUInt64LE(cursor)
    if (longLength > BigInt(MAX_ATTRIBUTED_BODY_BYTES)) return undefined
    length = Number(longLength)
    cursor += 8
  } else return undefined

  if (length <= 0 || length > MAX_ATTRIBUTED_BODY_BYTES || cursor + length > bytes.length) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(cursor, cursor + length))
  } catch {
    return undefined
  }
}

async function latestVerificationCode(
  databasePath: string,
  now: number,
  run: Run,
): Promise<string | undefined> {
  const bounds = timestampBounds(now)
  const query = `SELECT coalesce(m.text, '') AS text,
      CASE WHEN m.text IS NULL OR m.text = '' THEN coalesce(hex(m.attributedBody), '') ELSE '' END AS attributedHex,
      m.date FROM message AS m
    WHERE m.is_from_me = 0 AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
      AND length(coalesce(m.text, '')) <= 4096
      AND (m.attributedBody IS NULL OR length(m.attributedBody) <= ${MAX_ATTRIBUTED_BODY_BYTES})
      AND ((m.date > 1000000000000 AND m.date >= ${bounds.appleNanoseconds})
        OR (m.date <= 1000000000000 AND m.date >= ${bounds.appleSeconds}))
      AND NOT EXISTS (
        SELECT 1 FROM chat_message_join AS cmj JOIN chat AS c ON c.ROWID = cmj.chat_id
        WHERE cmj.message_id = m.ROWID AND c.style = 43
      )
    ORDER BY m.date DESC LIMIT ${QUERY_LIMIT};`
  const stdout = await run('/usr/bin/sqlite3', [
    '-readonly', '-json', '-batch',
    '-cmd', 'PRAGMA query_only=ON;',
    '-cmd', '.timeout 1000',
    databasePath,
    query,
  ])
  let rows: unknown
  try { rows = JSON.parse(stdout || '[]') } catch { throw new Error('Messages could not be read.') }
  const parsed = z.array(z.object({ text: z.string().max(4096), attributedHex: z.string().max(MAX_ATTRIBUTED_BODY_BYTES * 2), date: z.union([z.number(), z.string()]) })).safeParse(rows)
  if (!parsed.success) throw new Error('Messages could not be read.')

  for (const row of parsed.data as MessageRow[]) {
    const sentAt = appleDateToUnixMs(row.date)
    if (sentAt === undefined || sentAt < now - WINDOW_MS || sentAt > now + 60_000) continue
    const body = row.text || decodeTypedstreamAttributedBody(row.attributedHex ?? '') || ''
    const code = verificationCode(body)
    if (code) return code
  }
  return undefined
}

/** Reads only recent incoming message text on an explicit local tap; never polls or logs content. */
export function createMessages2FAProvider(options: Messages2FAOptions = {}): Provider {
  const databasePath = options.databasePath ?? MESSAGES_DB
  const now = options.now ?? Date.now
  const run = options.run ?? defaultRun
  const pasteboard = options.pasteboard ?? messagePasteboard
  const enabled = options.enabled ?? (() => false)
  let lastRequestAt: number | undefined

  return {
    channel: 'messages-2fa',
    commands: {
      copyLatest: async (payload: unknown, context?: CommandContext) => {
        if (context?.loopback !== true) return { ok: false, error: tr(undefined, 'messages2fa.localOnly') }
        if (!enabled()) return { ok: false, error: tr(undefined, 'messages2fa.disabled') }
        if (!RequestSchema.safeParse(payload).success) return { ok: false, error: tr(undefined, 'messages2fa.invalidRequest') }
        const requestedAt = now()
        if (lastRequestAt !== undefined && requestedAt - lastRequestAt < REQUEST_COOLDOWN_MS) {
          return { ok: false, error: tr(undefined, 'messages2fa.rateLimited') }
        }
        lastRequestAt = requestedAt
        let code: string | undefined
        try { code = await latestVerificationCode(databasePath, requestedAt, run) } catch {
          return { ok: false, error: tr(undefined, 'messages2fa.readFailed') }
        }
        if (!code) return { ok: false, error: tr(undefined, 'messages2fa.noneFound') }
        try { await pasteboard.write(code) } catch {
          return { ok: false, error: tr(undefined, 'messages2fa.copyFailed') }
        }
        // Keep the OTP on the local pasteboard only; never return it over the widget bridge.
        return { ok: true }
      },
    },
  }
}
