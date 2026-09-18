import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSecretStore } from '../src/secrets/file.js'
import { KeychainSecretStore } from '../src/secrets/keychain.js'
import { assertSecretKey, createSecretStore, defaultSecretsBackend } from '../src/secrets/index.js'

const dir = () => mkdtemp(join(tmpdir(), 'fremkit-secrets-'))

describe('assertSecretKey', () => {
  it('accepts a connection/field key', () => {
    expect(() => assertSecretKey('ado-x1z9/pat')).not.toThrow()
  })

  it('rejects a key without a field, with a traversal or with a space', () => {
    for (const bad of ['ado-x1z9', '../etc/passwd', 'ado x1z9/pat', 'ado/pat/extra', '/pat']) {
      expect(() => assertSecretKey(bad), bad).toThrow(/invalid secret key/)
    }
  })
})

describe('FileSecretStore', () => {
  it('returns null for a missing file and for an unknown key', async () => {
    const store = new FileSecretStore(join(await dir(), 'secrets.json'))
    expect(await store.get('ado-x1z9/pat')).toBeNull()
    await store.set('ado-x1z9/pat', 'token-1')
    expect(await store.get('bambu-a1b2/accessCode')).toBeNull()
  })

  it('creates the file with mode 600 and round-trips a value', async () => {
    const path = join(await dir(), 'secrets.json')
    const store = new FileSecretStore(path)
    await store.set('ado-x1z9/pat', 'token-1')
    expect(await store.get('ado-x1z9/pat')).toBe('token-1')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('keeps the other keys when one is written, and writes valid JSON', async () => {
    const path = join(await dir(), 'secrets.json')
    const store = new FileSecretStore(path)
    await store.set('ado-x1z9/pat', 'token-1')
    await store.set('bambu-a1b2/accessCode', '12345678')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      'ado-x1z9/pat': 'token-1',
      'bambu-a1b2/accessCode': '12345678',
    })
  })

  it('deletes a key and tolerates deleting one that is not there', async () => {
    const path = join(await dir(), 'secrets.json')
    const store = new FileSecretStore(path)
    await store.set('ado-x1z9/pat', 'token-1')
    await store.delete('ado-x1z9/pat')
    expect(await store.get('ado-x1z9/pat')).toBeNull()
    await expect(store.delete('ado-x1z9/pat')).resolves.toBeUndefined()
  })

  it('treats a corrupt file as empty instead of throwing', async () => {
    const path = join(await dir(), 'secrets.json')
    await writeFile(path, '{ not json', 'utf8')
    const store = new FileSecretStore(path)
    expect(await store.get('ado-x1z9/pat')).toBeNull()
    await store.set('ado-x1z9/pat', 'token-1')
    expect(await store.get('ado-x1z9/pat')).toBe('token-1')
  })

  it('ignores non-string values already in the file', async () => {
    const path = join(await dir(), 'secrets.json')
    await writeFile(path, JSON.stringify({ 'ado-x1z9/pat': 42, 'bambu-a1b2/accessCode': 'ok' }), 'utf8')
    const store = new FileSecretStore(path)
    expect(await store.get('ado-x1z9/pat')).toBeNull()
    expect(await store.get('bambu-a1b2/accessCode')).toBe('ok')
  })

  it('leaves no temporary file behind', async () => {
    const path = join(await dir(), 'secrets.json')
    await new FileSecretStore(path).set('ado-x1z9/pat', 'token-1')
    await expect(stat(path + '.tmp')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes overlapping set/delete calls so none is lost', async () => {
    const path = join(await dir(), 'secrets.json')
    const store = new FileSecretStore(path)
    await Promise.all([store.set('a/x', '1'), store.set('a/y', '2'), store.delete('a/x')])
    const fresh = new FileSecretStore(path)
    expect(await fresh.get('a/x')).toBeNull()
    expect(await fresh.get('a/y')).toBe('2')
  })

  it('lands all 20 concurrent sets', async () => {
    const path = join(await dir(), 'secrets.json')
    const store = new FileSecretStore(path)
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.set(`a/k${i}`, String(i))))
    const fresh = new FileSecretStore(path)
    for (let i = 0; i < 20; i++) expect(await fresh.get(`a/k${i}`)).toBe(String(i))
  })
})

describe('KeychainSecretStore', () => {
  const fake = (impl: (args: string[]) => Promise<{ stdout: string }>) => {
    const calls: string[][] = []
    const exec = async (cmd: string, args: string[]) => {
      expect(cmd).toBe('security')
      calls.push(args)
      return impl(args)
    }
    return { calls, exec }
  }
  const notFound = () => Object.assign(new Error('Command failed: security … -w token-1'), { code: 44 })

  it('reads with find-generic-password and strips the trailing newline', async () => {
    const { calls, exec } = fake(async () => ({ stdout: 'token-1\n' }))
    const store = new KeychainSecretStore(exec)
    expect(await store.get('ado-x1z9/pat')).toBe('token-1')
    expect(calls[0]).toEqual(['find-generic-password', '-s', 'fremkit', '-a', 'ado-x1z9/pat', '-w'])
  })

  it('returns null when the item is not in the keychain', async () => {
    const { exec } = fake(async () => { throw notFound() })
    expect(await new KeychainSecretStore(exec).get('ado-x1z9/pat')).toBeNull()
  })

  it('writes with -U so an existing item is updated', async () => {
    const { calls, exec } = fake(async () => ({ stdout: '' }))
    await new KeychainSecretStore(exec).set('ado-x1z9/pat', 'token-1')
    expect(calls[0]).toEqual(['add-generic-password', '-U', '-s', 'fremkit', '-a', 'ado-x1z9/pat', '-w', 'token-1'])
  })

  it('never puts the secret value in the error it raises', async () => {
    const { exec } = fake(async () => { throw Object.assign(new Error('Command failed: security add-generic-password -w token-1'), { code: 1 }) })
    await expect(new KeychainSecretStore(exec).set('ado-x1z9/pat', 'token-1')).rejects.toThrow(
      'trousseau : écriture impossible (code 1)',
    )
    await expect(new KeychainSecretStore(exec).set('ado-x1z9/pat', 'token-1')).rejects.not.toThrow(/token-1/)
  })

  it('deletes and stays quiet when there is nothing to delete', async () => {
    const { calls, exec } = fake(async (args) => { if (args[0] === 'delete-generic-password') throw notFound(); return { stdout: '' } })
    await expect(new KeychainSecretStore(exec).delete('ado-x1z9/pat')).resolves.toBeUndefined()
    expect(calls[0]).toEqual(['delete-generic-password', '-s', 'fremkit', '-a', 'ado-x1z9/pat'])
  })

  it('reports a read failure that is not a missing item', async () => {
    const { exec } = fake(async () => { throw Object.assign(new Error('boom'), { code: 51 }) })
    await expect(new KeychainSecretStore(exec).get('ado-x1z9/pat')).rejects.toThrow('trousseau : lecture impossible (code 51)')
  })
})

describe('backend selection', () => {
  it('defaults to the keychain on macOS and to a file elsewhere', () => {
    expect(defaultSecretsBackend('darwin')).toBe('keychain')
    expect(defaultSecretsBackend('linux')).toBe('file')
  })

  it('builds the store the backend asks for', async () => {
    expect(createSecretStore('file', await dir())).toBeInstanceOf(FileSecretStore)
    expect(createSecretStore('keychain', await dir())).toBeInstanceOf(KeychainSecretStore)
  })
})
