import { join } from 'node:path'
import { DpapiSecretStore, type DpapiUnreadable } from './dpapi.js'
import { FileSecretStore } from './file.js'
import { KEYCHAIN_SERVICE, KeychainSecretStore, instanceService, runSecurity } from './keychain.js'
import type { SecretStore } from './types.js'

export type SecretsBackend = 'keychain' | 'file' | 'dpapi'

/**
 * macOS gets the keychain and Windows DPAPI; everywhere else there is nothing to talk to, so a
 * 600 file.
 */
export function defaultSecretsBackend(platform: string = process.platform): SecretsBackend {
  if (platform === 'darwin') return 'keychain'
  if (platform === 'win32') return 'dpapi'
  return 'file'
}

/**
 * `adoptLegacyKeychain`: this instance may take over the items an earlier version filed under the
 * shared `fremkit` service. Only the live instance says so (see `KeychainSecretStore`).
 * `log`: told by a code, once, when the DPAPI store finds secrets it cannot read here.
 *
 * The backend names where secrets are kept, and the platform decides what that means: on Windows
 * `keychain` (a config brought over from a Mac) is DPAPI, and `dpapi` (one brought the other way)
 * is the platform's default elsewhere. Only `file` means the same everywhere.
 */
export function createSecretStore(
  backend: SecretsBackend,
  dataDir: string,
  opts: { adoptLegacyKeychain?: boolean; log?: (code: DpapiUnreadable) => void } = {},
  platform: string = process.platform,
): SecretStore {
  if (backend === 'file') return new FileSecretStore(join(dataDir, 'secrets.json'))
  if (platform === 'win32') return new DpapiSecretStore(dataDir, { log: opts.log })
  if (backend === 'dpapi' && defaultSecretsBackend(platform) === 'file') return new FileSecretStore(join(dataDir, 'secrets.json'))
  return new KeychainSecretStore(runSecurity, instanceService(dataDir), undefined, opts.adoptLegacyKeychain ? KEYCHAIN_SERVICE : undefined)
}

export { assertSecretKey, SECRET_KEY_RE, type SecretStore } from './types.js'
export { FileSecretStore } from './file.js'
export { DpapiSecretStore } from './dpapi.js'
export { KeychainSecretStore, KEYCHAIN_SERVICE, instanceService, execFileAsync, type Exec } from './keychain.js'
