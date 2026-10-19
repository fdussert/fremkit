import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSecretStore } from '../src/secrets/file.js'
import { KeychainSecretStore, accountsInDump, instanceService, parsePassword, passwordArgument, runSecurity } from '../src/secrets/keychain.js'
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
  const fake = (impl: (args: string[], input?: string) => Promise<{ stdout: string; stderr?: string }>) => {
    const calls: { args: string[]; input?: string }[] = []
    const run = async (args: string[], input?: string) => {
      calls.push({ args, input })
      const r = await impl(args, input)
      return { stdout: r.stdout, stderr: r.stderr ?? '' }
    }
    return { calls, run }
  }
  const notFound = () => Object.assign(new Error('Command failed: security find-generic-password'), { code: 44 })

  it('reads with find-generic-password -g, from what it prints on stderr', async () => {
    const { calls, run } = fake(async () => ({ stdout: 'keychain: "x"\n', stderr: 'password: "token-1"\n' }))
    const store = new KeychainSecretStore(run)
    expect(await store.get('ado-x1z9/pat')).toBe('token-1')
    expect(calls[0].args).toEqual(['find-generic-password', '-s', 'fremkit', '-a', 'ado-x1z9/pat', '-g'])
  })

  it('reads both of -g\'s forms, and tells a hex-looking token from a hex dump', () => {
    expect(parsePassword('password: "c3a9"\n')).toBe('c3a9')
    expect(parsePassword('password: 0xC3A9 \n')).toBe('é')
    expect(parsePassword('password: 0x61206222635C64  "a b"c\\134d"\n')).toBe('a b"c\\d')
    expect(parsePassword('password: "a b"c"\n')).toBe('a b"c')
    expect(parsePassword('password: \n')).toBe('')
    expect(parsePassword('nothing here')).toBeNull()
  })

  it('returns null when the item is not in the keychain', async () => {
    const { run } = fake(async () => { throw notFound() })
    expect(await new KeychainSecretStore(run).get('ado-x1z9/pat')).toBeNull()
  })

  it('writes through security -i on stdin: the value is never on a command line', async () => {
    const { calls, run } = fake(async () => ({ stdout: '' }))
    await new KeychainSecretStore(run).set('ado-x1z9/pat', 'token-1')
    expect(calls[0].args).toEqual(['-i'])
    expect(calls[0].args.join(' ')).not.toContain('token-1')
    expect(calls[0].input).toBe('add-generic-password -U -s fremkit -a ado-x1z9/pat -w "token-1"\n')
  })

  it('quotes printable values and hex-encodes the rest', () => {
    expect(passwordArgument('a b"c\\d')).toBe('-w "a b\\"c\\\\d"')
    expect(passwordArgument('')).toBe('-w ""')
    expect(passwordArgument('line\nbreak')).toBe(`-X ${Buffer.from('line\nbreak').toString('hex')}`)
    expect(passwordArgument('café ☕')).toBe(`-X ${Buffer.from('café ☕').toString('hex')}`)
    // Nothing that could end the line or the argument survives unencoded.
    for (const v of ['a\nadd-generic-password -s evil', 'x" -s other "y', '\r', '\u0000']) {
      expect(passwordArgument(v)).not.toMatch(/\n|\r|\u0000/)
      expect(passwordArgument(v).startsWith('-X ') || /^-w "([^"\\]|\\.)*"$/.test(passwordArgument(v))).toBe(true)
    }
  })

  it('refuses a value too long for one interactive line rather than storing half of it', async () => {
    const { calls, run } = fake(async () => ({ stdout: '' }))
    await expect(new KeychainSecretStore(run).set('a/b', 'é'.repeat(1200))).rejects.toThrow(/too long/)
    expect(calls).toHaveLength(0)
  })

  it('never puts the secret value in the error it raises', async () => {
    const { run } = fake(async () => { throw Object.assign(new Error('Command failed: security -i token-1'), { code: 1, stderr: 'token-1' }) })
    await expect(new KeychainSecretStore(run).set('ado-x1z9/pat', 'token-1')).rejects.toThrow(
      'trousseau : écriture impossible (code 1)',
    )
    await expect(new KeychainSecretStore(run).set('ado-x1z9/pat', 'token-1')).rejects.not.toThrow(/token-1/)
  })

  it('deletes and stays quiet when there is nothing to delete', async () => {
    const { calls, run } = fake(async (args) => { if (args[0] === 'delete-generic-password') throw notFound(); return { stdout: '' } })
    await expect(new KeychainSecretStore(run).delete('ado-x1z9/pat')).resolves.toBeUndefined()
    expect(calls[0].args).toEqual(['delete-generic-password', '-s', 'fremkit', '-a', 'ado-x1z9/pat'])
  })

  it('reports a read failure that is not a missing item', async () => {
    const { run } = fake(async () => { throw Object.assign(new Error('boom'), { code: 51 }) })
    await expect(new KeychainSecretStore(run).get('ado-x1z9/pat')).rejects.toThrow('trousseau : lecture impossible (code 51)')
  })

  it('lists the accounts of its own service out of dump-keychain, attributes only', async () => {
    const dump = [
      'keychain: "/k"\nclass: "genp"\nattributes:\n    "acct"<blob>="gh-x1/token"\n    "svce"<blob>="fremkit"\n',
      'keychain: "/k"\nclass: "genp"\nattributes:\n    "acct"<blob>="gh-x1/other"\n    "svce"<blob>="fremkit"\n',
      'keychain: "/k"\nclass: "genp"\nattributes:\n    "acct"<blob>="gh-x1/token"\n    "svce"<blob>="something-else"\n',
      'keychain: "/k"\nclass: "genp"\nattributes:\n    "acct"<blob>="gh-x12/token"\n    "svce"<blob>="fremkit"\n',
    ].join('')
    expect(accountsInDump(dump, 'fremkit')).toEqual(['gh-x1/token', 'gh-x1/other', 'gh-x12/token'])
    const { calls, run } = fake(async () => ({ stdout: dump }))
    expect(await new KeychainSecretStore(run).keysOf('gh-x1')).toEqual(['gh-x1/token', 'gh-x1/other'])
    expect(calls[0].args).toEqual(['dump-keychain'])
  })

  it('files each instance under its own service, named after its data folder', () => {
    expect(instanceService('/tmp/a/data')).toMatch(/^fremkit:[0-9a-f]{12}$/)
    expect(instanceService('/tmp/a/data')).toBe(instanceService('/tmp/a/./data'))
    expect(instanceService('/tmp/a/data')).not.toBe(instanceService('/tmp/b/data'))
  })

  it('adopts an item an earlier version filed under the shared service, only when allowed', async () => {
    const store = new Map<string, string>([['fremkit|gh-x1/token', 'legacy-token']])
    const keyOf = (args: string[]) => `${args[args.indexOf('-s') + 1]}|${args[args.indexOf('-a') + 1]}`
    const { calls, run } = fake(async (args, input) => {
      if (args[0] === 'find-generic-password') {
        const v = store.get(keyOf(args))
        if (v === undefined) throw notFound()
        return { stdout: '', stderr: `password: "${v}"\n` }
      }
      if (args[0] === '-i') {
        const words = input!.trim().split(' ')
        store.set(`${words[words.indexOf('-s') + 1]}|${words[words.indexOf('-a') + 1]}`, input!.match(/-w "(.*)"/)![1])
        return { stdout: '' }
      }
      if (args[0] === 'delete-generic-password') {
        if (!store.delete(keyOf(args))) throw notFound()
        return { stdout: '' }
      }
      return { stdout: '' }
    })
    // A second instance (no legacy service) neither sees nor touches the shared item.
    const second = new KeychainSecretStore(run, 'fremkit:bbbbbbbbbbbb')
    expect(await second.get('gh-x1/token')).toBeNull()
    await second.delete('gh-x1/token')
    expect(store.get('fremkit|gh-x1/token')).toBe('legacy-token')
    expect(calls.every((c) => !c.args.includes('fremkit') && !(c.input ?? '').includes('-s fremkit '))).toBe(true)
    // The live instance moves it to its own service on first read.
    const live = new KeychainSecretStore(run, 'fremkit:aaaaaaaaaaaa', undefined, 'fremkit')
    expect(await live.get('gh-x1/token')).toBe('legacy-token')
    expect(store.get('fremkit:aaaaaaaaaaaa|gh-x1/token')).toBe('legacy-token')
    expect(store.has('fremkit|gh-x1/token')).toBe(false)
    expect(await live.get('gh-x1/token')).toBe('legacy-token')
  })

  it('refuses a keychain path it could not put on an interactive line', () => {
    expect(() => new KeychainSecretStore(undefined, 'fremkit', '/tmp/a b.keychain')).toThrow()
  })
})

/**
 * Against the real `security`, in a throwaway keychain file — never the login keychain. Opt-in
 * (`FREMKIT_KEYCHAIN_IT=1`): creating a keychain adds it to the user's search list until it is
 * deleted, which a routine `pnpm test` has no business doing.
 */
describe.runIf(process.platform === 'darwin' && process.env.FREMKIT_KEYCHAIN_IT === '1')('KeychainSecretStore against security', () => {
  let kdir: string
  let keychain: string
  beforeAll(async () => {
    kdir = await mkdtemp(join(tmpdir(), 'fremkit-kc-'))
    keychain = join(kdir, 'test.keychain-db')
    await runSecurity(['create-keychain', '-p', 'throwaway', keychain])
    await runSecurity(['unlock-keychain', '-p', 'throwaway', keychain])
  })
  afterAll(async () => {
    await runSecurity(['delete-keychain', keychain]).catch(() => {})
    await rm(kdir, { recursive: true, force: true })
  })

  it('round-trips values with quotes, spaces, newlines, unicode and shell characters', async () => {
    const store = new KeychainSecretStore(runSecurity, 'fremkit-it', keychain)
    const values = [
      'plain-token', 'with spaces', 'double " quote', "single ' quote", 'back\\slash', 'trailing\\',
      '"', 'line\nbreak', 'tab\there', 'café ☕ 東京', '$HOME `id` $(id) ; # & | < >', 'deadbeefc3a9', '0x41',
      ' leading and trailing ', '-w "evil"', 'x'.repeat(3700), '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
    ]
    for (const [i, v] of values.entries()) {
      await store.set(`it/k${i}`, v)
      expect(await store.get(`it/k${i}`), JSON.stringify(v).slice(0, 40)).toBe(v)
    }
    // Another instance's service sees none of it.
    expect(await new KeychainSecretStore(runSecurity, 'fremkit-it-other', keychain).get('it/k1')).toBeNull()
    // Adoption from a legacy service, for real.
    await new KeychainSecretStore(runSecurity, 'fremkit-it-legacy', keychain).set('it/old', 'from before')
    const adopting = new KeychainSecretStore(runSecurity, 'fremkit-it-new', keychain, 'fremkit-it-legacy')
    expect(await adopting.get('it/old')).toBe('from before')
    expect(await new KeychainSecretStore(runSecurity, 'fremkit-it-legacy', keychain).get('it/old')).toBeNull()
    expect(await new KeychainSecretStore(runSecurity, 'fremkit-it-new', keychain).get('it/old')).toBe('from before')
    // -U replaces.
    await store.set('it/k0', 'replaced')
    expect(await store.get('it/k0')).toBe('replaced')
    await store.delete('it/k0')
    expect(await store.get('it/k0')).toBeNull()
    expect((await store.keysOf('it')).sort()).toEqual(values.slice(1).map((_, i) => `it/k${i + 1}`).sort())
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
