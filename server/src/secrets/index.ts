import { join } from 'node:path'
import { FileSecretStore } from './file.js'
import { KeychainSecretStore } from './keychain.js'
import type { SecretStore } from './types.js'

export type SecretsBackend = 'keychain' | 'file'

/** macOS gets the keychain; everywhere else there is nothing to talk to, so a 600 file. */
export function defaultSecretsBackend(platform: string = process.platform): SecretsBackend {
  return platform === 'darwin' ? 'keychain' : 'file'
}

export function createSecretStore(backend: SecretsBackend, dataDir: string): SecretStore {
  return backend === 'keychain' ? new KeychainSecretStore() : new FileSecretStore(join(dataDir, 'secrets.json'))
}

export { assertSecretKey, SECRET_KEY_RE, type SecretStore } from './types.js'
export { FileSecretStore } from './file.js'
export { KeychainSecretStore, KEYCHAIN_SERVICE, execFileAsync, type Exec } from './keychain.js'
