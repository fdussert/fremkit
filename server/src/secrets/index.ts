import { join } from 'node:path'
import { FileSecretStore } from './file.js'
import { KEYCHAIN_SERVICE, KeychainSecretStore, instanceService, runSecurity } from './keychain.js'
import type { SecretStore } from './types.js'

export type SecretsBackend = 'keychain' | 'file'

/** macOS gets the keychain; everywhere else there is nothing to talk to, so a 600 file. */
export function defaultSecretsBackend(platform: string = process.platform): SecretsBackend {
  return platform === 'darwin' ? 'keychain' : 'file'
}

/**
 * `adoptLegacyKeychain`: this instance may take over the items an earlier version filed under the
 * shared `fremkit` service. Only the live instance says so (see `KeychainSecretStore`).
 */
export function createSecretStore(backend: SecretsBackend, dataDir: string, opts: { adoptLegacyKeychain?: boolean } = {}): SecretStore {
  if (backend !== 'keychain') return new FileSecretStore(join(dataDir, 'secrets.json'))
  return new KeychainSecretStore(runSecurity, instanceService(dataDir), undefined, opts.adoptLegacyKeychain ? KEYCHAIN_SERVICE : undefined)
}

export { assertSecretKey, SECRET_KEY_RE, type SecretStore } from './types.js'
export { FileSecretStore } from './file.js'
export { KeychainSecretStore, KEYCHAIN_SERVICE, instanceService, execFileAsync, type Exec } from './keychain.js'
