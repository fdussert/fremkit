import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { CommandContext, Provider } from './types.js'
import { tr } from '../i18n.js'

/**
 * The clipboard history.
 *
 * Everything here lives in memory and only in memory: nothing is written to `data/`, nothing is
 * logged, and nothing leaves the Mac. The pasteboard is read only while a widget is subscribed to
 * the channel — the registry starts and stops the polling with the last subscriber — and an entry
 * that looks like a secret is kept copyable but never shown.
 */

/** How many distinct entries are remembered. */
export const MAX_ENTRIES = 20
/** Largest text kept per entry. Anything longer is truncated before it is stored. */
export const MAX_TEXT_BYTES = 2048
/** How much of an entry the widget is shown. */
export const PREVIEW_CHARS = 120
/** What stands in for the preview of an entry that looks like a secret. */
export const MASKED_PREVIEW = '••••'
/** A run of this many characters with no whitespace reads as a token, not as prose. */
export const SECRET_MIN_LENGTH = 32

/** Substrings that mark a text as a secret whatever its shape. Matched case-insensitively. */
const SECRET_MARKERS = ['password', 'secret', 'bearer', 'private key', 'sk-', 'ghp_']

export interface ClipboardEntry { id: string; text: string; at: number; masked: boolean }
/** What the channel publishes: the preview, never the text. */
export interface PublicEntry { id: string; preview: string; at: number; masked: boolean }
export interface ClipboardSnapshot { entries: PublicEntry[] }

/** Reading and writing the pasteboard, injectable so tests never touch the real one. */
export interface Pasteboard {
  read(): Promise<string>
  write(text: string): Promise<void>
}

export const pbPasteboard: Pasteboard = {
  read: () => new Promise((resolve, reject) => {
    execFile('pbpaste', [], { timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      // A pasteboard holding no text at all is not an error: it is simply nothing to record.
      if (err) reject(new Error(err.message))
      else resolve(stdout)
    })
  }),
  write: (text) => new Promise((resolve, reject) => {
    const child = execFile('pbcopy', [], { timeout: 5000 }, (err) => (err ? reject(new Error(err.message)) : resolve()))
    child.stdin?.end(text)
  }),
}

/** Truncates to `MAX_TEXT_BYTES`, on a character boundary. */
export function capText(text: string): string {
  if (Buffer.byteLength(text) <= MAX_TEXT_BYTES) return text
  let cut = text.slice(0, MAX_TEXT_BYTES)
  while (cut.length > 0 && Buffer.byteLength(cut) > MAX_TEXT_BYTES) cut = cut.slice(0, -1)
  return cut
}

/**
 * Whether a text is treated as a secret: a long unbroken run of characters — an API key, a token,
 * a password — or a text naming one outright. Deliberately generous: a false positive costs the
 * user a preview, a false negative puts their key on a screen on a desk.
 */
export function isSecret(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length >= SECRET_MIN_LENGTH && !/\s/.test(trimmed)) return true
  const lower = trimmed.toLowerCase()
  return SECRET_MARKERS.some((marker) => lower.includes(marker))
}

export function previewOf(text: string, masked: boolean): string {
  if (masked) return MASKED_PREVIEW
  return text.slice(0, PREVIEW_CHARS)
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')

const CopyPayloadSchema = z.object({ id: z.string().min(1).max(64) })

export function createClipboardProvider(pasteboard: Pasteboard = pbPasteboard, now: () => number = Date.now): Provider {
  /** Newest first. */
  let entries: ClipboardEntry[] = []
  const hashes = new Map<string, string>() // hash -> entry id
  let lastHash: string | null = null
  let nextId = 1

  const publicEntries = (): PublicEntry[] =>
    entries.map((e) => ({ id: e.id, preview: previewOf(e.text, e.masked), at: e.at, masked: e.masked }))

  /** Records a pasteboard reading, moving a text already known back to the front. */
  const record = (raw: string): void => {
    const text = capText(raw)
    if (!text.trim()) return
    const key = hash(text)
    if (key === lastHash) return
    lastHash = key
    const knownId = hashes.get(key)
    if (knownId) {
      const index = entries.findIndex((e) => e.id === knownId)
      if (index >= 0) {
        const [existing] = entries.splice(index, 1)
        existing.at = now()
        entries.unshift(existing)
        return
      }
      hashes.delete(key)
    }
    const entry: ClipboardEntry = { id: String(nextId++), text, at: now(), masked: isSecret(text) }
    entries.unshift(entry)
    hashes.set(key, entry.id)
    for (const dropped of entries.splice(MAX_ENTRIES)) {
      for (const [h, id] of hashes) if (id === dropped.id) hashes.delete(h)
    }
  }

  return {
    channel: 'clipboard',
    intervalMs: 1000,
    async poll(): Promise<ClipboardSnapshot> {
      try {
        record(await pasteboard.read())
      } catch {
        // An unreadable pasteboard (no text on it, `pbpaste` unavailable) leaves the history as
        // it is rather than emptying the widget.
      }
      return { entries: publicEntries() }
    },
    /** The history never outlives the server, and never outlives the widget that showed it. */
    stop() {
      entries = []
      hashes.clear()
      lastHash = null
    },
    commands: {
      copy: async (payload, ctx?: CommandContext) => {
        // Writing the pasteboard acts on the user's Mac: only a client on that Mac may ask.
        if (!ctx?.loopback) return { ok: false, error: tr(undefined, 'provider.localOnly') }
        const parsed = CopyPayloadSchema.safeParse(payload)
        if (!parsed.success) return { ok: false, error: 'charge utile invalide' }
        const entry = entries.find((e) => e.id === parsed.data.id)
        if (!entry) return { ok: false, error: 'entrée inconnue' }
        try {
          await pasteboard.write(entry.text)
        } catch (err) {
          return { ok: false, error: (err as Error).message || String(err) }
        }
        // The next poll would otherwise see this as a fresh copy and reorder the list under the
        // finger that just tapped it.
        lastHash = hash(entry.text)
        return { ok: true }
      },
      clear: async () => {
        entries = []
        hashes.clear()
        return { ok: true, entries: [] as PublicEntry[] }
      },
    },
  }
}
