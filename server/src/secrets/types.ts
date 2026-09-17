/** A place to keep connection secrets. Keys are `<connectionId>/<fieldKey>`. */
export interface SecretStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * Exactly two segments, each a safe identifier: the key ends up as a JSON object key in the
 * file backend and as a keychain account name (and argv value) in the keychain backend.
 */
export const SECRET_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9_-]*$/

export function assertSecretKey(key: string): void {
  if (!SECRET_KEY_RE.test(key)) throw new Error(`clé de secret invalide : ${key}`)
}
