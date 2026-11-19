import { readFile, stat as statFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultConfigDir } from './configDirs.js'

/**
 * Which claude.ai account each Claude Code configuration folder is signed in to.
 *
 * Claude Code writes the signed-in account to `<dir>/.claude.json` (`~/.claude.json` for the
 * default folder) under `oauthAccount`: its uuid, its organisation and the organisation's type,
 * from which the plan is named. Reading it is a file read: no keychain, no network. Two folders
 * holding the same uuid are one account, which a terminal with profiles produces as soon as the
 * default folder and one profile are signed in to the same claude.ai account.
 *
 * What comes out carries the e-mail address and the uuid. Neither leaves the server as is: the
 * account provider gates the address (`privacy.ts`) and sends widgets a hash of the uuid.
 */
export interface FolderAccount {
  /** `oauthAccount.accountUuid`. An identifier: never in diagnostics, never in a shared layout. */
  uuid: string
  /** `Max`, `Team`, …; null when the file does not say. */
  plan: string | null
  /** The organisation's name; null when it holds an address (a personal one is named after it). */
  org: string | null
  /** The account's e-mail address. Published only through `withAccountEmail()`. */
  email: string | null
}

export interface DiscoveredAccount extends FolderAccount {
  /** The folders signed in to it, in the order they were listed, the default folder last. */
  dirs: string[]
  /** The latest event any of its folders sent (ms), or null when none ever did. */
  lastSeen: number | null
}

const UUID_RE = /^[0-9a-f-]{8,64}$/i
/** A `.claude.json` holds every project's history; past this it is not one Claude Code wrote. */
const MAX_FILE_BYTES = 64 * 1024 * 1024

const PLANS: Record<string, string> = {
  claude_max: 'Max', claude_pro: 'Pro', claude_team: 'Team', claude_enterprise: 'Enterprise',
}

/** The plan's name: from the organisation's type, else from the display name the file sometimes has. */
export function planOf(organizationType: unknown, planDisplayName?: unknown): string | null {
  if (typeof organizationType === 'string' && PLANS[organizationType]) return PLANS[organizationType]
  if (typeof planDisplayName !== 'string') return null
  const name = planDisplayName.trim()
  return name && name.length <= 40 && !name.includes('@') ? name : null
}

/** Where Claude Code keeps the folder's settings, the signed-in account among them. */
export function claudeJsonOf(dir: string, home = homedir()): string {
  return dir === defaultConfigDir() ? join(home, '.claude.json') : join(dir, '.claude.json')
}

/** An address, or something built around one, such as "<email>'s Organization". */
export const isEmailLike = (text: string): boolean => text.includes('@')

/** The account a `.claude.json` is signed in to; null when it is none or the file is unreadable. */
export function parseFolderAccount(raw: string): FolderAccount | null {
  let json: unknown
  try { json = JSON.parse(raw) } catch { return null }
  const o = (json as { oauthAccount?: Record<string, unknown> } | null)?.oauthAccount
  if (!o || typeof o !== 'object') return null
  const uuid = o.accountUuid
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) return null
  const org = typeof o.organizationName === 'string' ? o.organizationName.trim().slice(0, 100) : ''
  const email = typeof o.emailAddress === 'string' && o.emailAddress.length <= 320 ? o.emailAddress : null
  return {
    uuid: uuid.toLowerCase(),
    plan: planOf(o.organizationType, o.planDisplayName),
    org: org && !isEmailLike(org) ? org : null,
    email,
  }
}

async function readSmallFile(path: string): Promise<string> {
  const s = await statFile(path)
  if (s.size > MAX_FILE_BYTES) throw new Error('too large')
  return readFile(path, 'utf8')
}

export class ClaudeAccountDiscovery {
  /** By file: the modification time last read and what it said. Parsed again only on change. */
  private cache = new Map<string, { mtime: number; account: FolderAccount | null }>()
  private readonly read: (path: string) => Promise<string>
  private readonly stat: (path: string) => Promise<number>

  constructor(private readonly opts: {
    /** The folders sessions were seen running from (`ClaudeConfigDirs.list`). */
    dirs: () => string[]
    lastSeen: (dir: string) => number | null
    home?: string
    /** Test seams. */
    read?: (path: string) => Promise<string>
    stat?: (path: string) => Promise<number>
  }) {
    this.read = opts.read ?? readSmallFile
    this.stat = opts.stat ?? (async (path) => (await statFile(path)).mtimeMs)
  }

  /** The account a folder is signed in to, or null. */
  async accountOf(dir: string): Promise<FolderAccount | null> {
    const path = claudeJsonOf(dir, this.opts.home)
    let mtime: number
    try { mtime = await this.stat(path) } catch { this.cache.delete(path); return null }
    const cached = this.cache.get(path)
    if (cached && cached.mtime === mtime) return cached.account
    let account: FolderAccount | null = null
    try { account = parseFolderAccount(await this.read(path)) } catch { /* vanished or too large */ }
    this.cache.set(path, { mtime, account })
    return account
  }

  /** Every account of the known folders and the default one, each listed once. */
  async list(): Promise<DiscoveredAccount[]> {
    const dirs = [...new Set([...this.opts.dirs(), defaultConfigDir()])]
    for (const path of [...this.cache.keys()]) {
      if (!dirs.some((d) => claudeJsonOf(d, this.opts.home) === path)) this.cache.delete(path)
    }
    const byUuid = new Map<string, DiscoveredAccount>()
    for (const dir of dirs) {
      const account = await this.accountOf(dir)
      if (!account) continue
      const seen = this.opts.lastSeen(dir)
      const known = byUuid.get(account.uuid)
      if (!known) { byUuid.set(account.uuid, { ...account, dirs: [dir], lastSeen: seen }); continue }
      known.dirs.push(dir)
      if (seen !== null && (known.lastSeen === null || seen > known.lastSeen)) known.lastSeen = seen
      known.plan ??= account.plan
      known.org ??= account.org
      known.email ??= account.email
    }
    return [...byUuid.values()]
  }
}
