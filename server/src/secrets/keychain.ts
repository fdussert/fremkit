import { execFile } from 'node:child_process'
import { assertSecretKey, type SecretStore } from './types.js'

/** Keychain service under which every Fremkit secret is filed. */
export const KEYCHAIN_SERVICE = 'fremkit'

export type Exec = (cmd: string, args: string[]) => Promise<{ stdout: string }>

const TIMEOUT_MS = 5000

export const execFileAsync: Exec = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }))
      else resolve({ stdout })
    })
  })

/** Exit status `security` uses for "the item is not in the keychain". */
const ERR_ITEM_NOT_FOUND = 44

function isNotFound(err: unknown): boolean {
  const e = err as { code?: unknown; stderr?: unknown }
  if (e?.code === ERR_ITEM_NOT_FOUND) return true
  // Fallback only: `security`'s stderr text is locale-dependent (a non-English system locale
  // phrases it differently), so the exit code above is the reliable check and this is best-effort.
  return typeof e?.stderr === 'string' && /could not be found/i.test(e.stderr)
}

/**
 * Describes a failed `security` call **without its message**.
 *
 * Node builds the message from the command line, and `add-generic-password -w <value>` carries
 * the secret there, so propagating `err.message` would leak the secret into logs and HTTP bodies.
 * Only the exit status ever leaves this module.
 */
function describe(err: unknown): string {
  const e = err as { code?: unknown; signal?: unknown }
  if (typeof e?.code === 'number') return `code ${e.code}`
  if (typeof e?.code === 'string') return e.code
  if (typeof e?.signal === 'string') return `signal ${e.signal}`
  return 'erreur inconnue'
}

/**
 * Secrets in the macOS keychain, via the `security` command line tool.
 *
 * Known limitation, accepted for a single-user desktop: `add-generic-password -w <value>` puts
 * the secret in argv, where any process of the same user can see it for the duration of the
 * call. The alternative (`-w` reading stdin) is not offered by `security`. Documented in the
 * README so a user on a shared machine can pick the file backend instead.
 */
export class KeychainSecretStore implements SecretStore {
  constructor(private readonly exec: Exec = execFileAsync, private readonly service: string = KEYCHAIN_SERVICE) {}

  async get(key: string): Promise<string | null> {
    assertSecretKey(key)
    try {
      const { stdout } = await this.exec('security', ['find-generic-password', '-s', this.service, '-a', key, '-w'])
      return stdout.replace(/\n$/, '')
    } catch (err) {
      if (isNotFound(err)) return null
      throw new Error(`trousseau : lecture impossible (${describe(err)})`)
    }
  }

  async set(key: string, value: string): Promise<void> {
    assertSecretKey(key)
    try {
      await this.exec('security', ['add-generic-password', '-U', '-s', this.service, '-a', key, '-w', value])
    } catch (err) {
      throw new Error(`trousseau : écriture impossible (${describe(err)})`)
    }
  }

  async delete(key: string): Promise<void> {
    assertSecretKey(key)
    try {
      await this.exec('security', ['delete-generic-password', '-s', this.service, '-a', key])
    } catch (err) {
      if (isNotFound(err)) return
      throw new Error(`trousseau : suppression impossible (${describe(err)})`)
    }
  }
}
