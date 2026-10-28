import { describe, it, expect, afterEach } from 'vitest'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, lstat, symlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACL_RESET_MARKER, tightenDataDir, restrictToUser, type AclExec } from '../src/data-permissions.js'
import { windowsTool } from '../src/platform/windows-tools.js'
import { writeAccessToken } from '../src/http/access-file.js'
import { buildApp } from '../src/app.js'

const mode = async (path: string) => (await stat(path)).mode & 0o777
let root: string
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })

// POSIX modes: Windows has no owner/group/other bits; its ACL is checked in the last block.
const itPosix = it.skipIf(process.platform === 'win32')

describe('tightenDataDir', () => {
  itPosix('brings an older data folder to 0700 folders and 0600 files, links left alone', async () => {
    root = await mkdtemp(join(tmpdir(), 'fremkit-perm-'))
    const data = join(root, 'data')
    await mkdir(join(data, 'disk-map'), { recursive: true })
    await writeFile(join(data, 'fremkit.json'), '{}')
    await writeFile(join(data, 'fremkit.json.bak'), '{}')
    await writeFile(join(data, 'disk-map', 'home.json'), '{}')
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'x')
    await symlink(outside, join(data, 'link'))
    for (const p of [data, join(data, 'disk-map')]) await chmod(p, 0o755)
    for (const p of [join(data, 'fremkit.json'), join(data, 'fremkit.json.bak'), join(data, 'disk-map', 'home.json'), outside]) await chmod(p, 0o644)

    expect(await tightenDataDir(data)).toBe(5)
    expect(await mode(data)).toBe(0o700)
    expect(await mode(join(data, 'disk-map'))).toBe(0o700)
    expect(await mode(join(data, 'fremkit.json'))).toBe(0o600)
    expect(await mode(join(data, 'fremkit.json.bak'))).toBe(0o600)
    expect(await mode(join(data, 'disk-map', 'home.json'))).toBe(0o600)
    // Not followed: the file a link points at keeps its mode.
    expect(await mode(outside)).toBe(0o644)
    expect((await lstat(join(data, 'link'))).isSymbolicLink()).toBe(true)
    // Nothing left to do the second time.
    expect(await tightenDataDir(data)).toBe(0)
  })

  itPosix('runs when the server starts, and the config it writes is private', async () => {
    root = await mkdtemp(join(tmpdir(), 'fremkit-perm-'))
    const data = join(root, 'data')
    await mkdir(data, { recursive: true, mode: 0o755 })
    await chmod(data, 0o755)
    await writeFile(join(data, 'claude-usage.json'), '{}', { mode: 0o644 })
    await chmod(join(data, 'claude-usage.json'), 0o644)
    const app = await buildApp({ accessToken: null, dataDir: data, widgetsDir: join(root, 'widgets'), uiDist: join(root, 'ui') })
    try {
      expect(await mode(data)).toBe(0o700)
      expect(await mode(join(data, 'claude-usage.json'))).toBe(0o600)
      const res = await app.inject({ method: 'PUT', url: '/api/config', headers: { host: '127.0.0.1:4242' }, payload: (await app.inject({ url: '/api/config', headers: { host: '127.0.0.1:4242' } })).json() })
      expect(res.statusCode).toBe(200)
      expect(await mode(join(data, 'fremkit.json'))).toBe(0o600)
    } finally {
      await app.close()
    }
  })
})

describe('tightenDataDir on Windows', () => {
  const SID = 'S-1-5-21-1-2-3-1001'
  const fake = (whoami: string) => {
    const calls: Array<{ file: string; args: string[] }> = []
    const exec: AclExec = async (file, args) => {
      calls.push({ file, args })
      return file.endsWith('whoami.exe') ? { stdout: whoami } : { stdout: '' }
    }
    return { calls, exec }
  }

  it('grants the user and SYSTEM only, inherited, by SID', async () => {
    root = await mkdtemp(join(tmpdir(), 'fremkit-perm-'))
    const { calls, exec } = fake(`"desktop-x\\a","${SID}"\r\n`)
    expect(await tightenDataDir(root, { platform: 'win32', exec })).toBe(1)
    expect(calls[0]).toEqual({ file: windowsTool('whoami'), args: ['/user', '/fo', 'csv', '/nh'] })
    expect(calls[1]).toEqual({
      file: windowsTool('icacls'),
      args: [root, '/inheritance:r', '/grant:r', `*${SID}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '/C', '/Q'],
    })
    // An empty folder has nothing to reset (icacls fails on `\\*` there).
    expect(calls).toHaveLength(2)
  })

  it('then resets what the folder already holds to inherit from it, links themselves only', async () => {
    root = await mkdtemp(join(tmpdir(), 'fremkit-perm-'))
    await writeFile(join(root, 'fremkit.json'), '{}')
    const { calls, exec } = fake(`"a","${SID}"`)
    expect(await tightenDataDir(root, { platform: 'win32', exec })).toBe(1)
    // No marker yet: no need to read the folder's ACL, the walk runs.
    expect(calls).toHaveLength(3)
    expect(calls[2]).toEqual({ file: windowsTool('icacls'), args: [`${root}\\*`, '/reset', '/T', '/C', '/L', '/Q'] })
    // The folder is protected without /T: a file would be left with an empty ACL.
    expect(calls[1].args).not.toContain('/T')
    // The completed walk is recorded.
    expect(await readdir(root)).toContain(ACL_RESET_MARKER)
  })

  it('walks again at the next start when the first walk failed, though the folder is restricted', async () => {
    root = await mkdtemp(join(tmpdir(), 'fremkit-perm-'))
    await writeFile(join(root, 'fremkit.json'), '{}')
    const restricted = `${root} NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\r\n`
    const start = async (resetFails: boolean) => {
      const resets: string[][] = []
      const exec: AclExec = async (file, args) => {
        if (file.endsWith('whoami.exe')) return { stdout: `"a","${SID}"` }
        if (args.length === 1) return { stdout: restricted }
        if (args.includes('/reset')) {
          resets.push(args)
          if (resetFails) throw new Error('timed out')
        }
        return { stdout: '' }
      }
      await tightenDataDir(root, { platform: 'win32', exec })
      return resets.length
    }
    expect(await start(true)).toBe(1)
    expect(await readdir(root)).not.toContain(ACL_RESET_MARKER)
    expect(await start(false)).toBe(1)
    expect(await readdir(root)).toContain(ACL_RESET_MARKER)
    expect(await start(false)).toBe(0)
  })

  it('skips the walk once the folder no longer inherits from its parent', async () => {
    root = await mkdtemp(join(tmpdir(), 'fremkit-perm-'))
    await writeFile(join(root, 'fremkit.json'), '{}')
    const read = (aces: string[]) => `${root} ${aces[0]}\r\n${aces.slice(1).map((a) => `${' '.repeat(root.length)} ${a}`).join('\r\n')}\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`
    await writeFile(join(root, ACL_RESET_MARKER), '')
    const run = async (acl: string) => {
      const calls: string[][] = []
      const exec: AclExec = async (file, args) => {
        calls.push(args)
        if (file.endsWith('whoami.exe')) return { stdout: `"a","${SID}"` }
        return { stdout: args.length === 1 ? acl : '' }
      }
      expect(await tightenDataDir(root, { platform: 'win32', exec })).toBe(1)
      return calls.some((args) => args.includes('/reset'))
    }
    // Restricted at an earlier start: user and SYSTEM, nothing inherited.
    expect(await run(read(['NT AUTHORITY\\SYSTEM:(OI)(CI)(F)', 'DESKTOP-X\\a:(OI)(CI)(F)']))).toBe(false)
    // Still inheriting (a fresh folder, or inheritance turned back on), in any language.
    expect(await run(read(['AUTORITE NT\\Système:(I)(OI)(CI)(F)', 'BUILTIN\\Utilisateurs:(I)(OI)(CI)(RX)']))).toBe(true)
    // An answer it cannot read: walk.
    expect(await run('')).toBe(true)
  })

  it('a partial reset is reported too', async () => {
    root = await mkdtemp(join(tmpdir(), 'fremkit-perm-'))
    await writeFile(join(root, 'fremkit.json'), '{}')
    const logged: string[] = []
    let n = 0
    const exec: AclExec = async (file) => {
      if (file.endsWith('whoami.exe')) return { stdout: `"a","${SID}"` }
      return { stdout: ++n === 2 ? 'Successfully processed 1 files; Failed processing 1 files' : 'Successfully processed 1 files; Failed processing 0 files' }
    }
    expect(await tightenDataDir(root, { platform: 'win32', exec, log: (c) => logged.push(c) })).toBe(0)
    expect(logged).toEqual(['acl-icacls-partial'])
  })

  it('reads a localized whoami: only the SID column matters', async () => {
    root = await mkdtemp(join(tmpdir(), 'fremkit-perm-'))
    const { calls, exec } = fake(`"poste\\é, utilisateur","${SID}"\r\n`)
    expect(await tightenDataDir(root, { platform: 'win32', exec })).toBe(1)
    expect(calls.find((c) => c.args.includes('/inheritance:r'))!.args[3]).toBe(`*${SID}:(OI)(CI)F`)
  })

  it('applies nothing when whoami answers something that is not a user SID', async () => {
    root = await mkdtemp(join(tmpdir(), 'fremkit-perm-'))
    for (const out of ['', 'garbage', '"a","S-1-5-18"', '"a","S-1-5-21-1-2-3"', `"a","${SID}*"`]) {
      const { calls, exec } = fake(out)
      expect(await tightenDataDir(root, { platform: 'win32', exec })).toBe(0)
      expect(calls.every((c) => c.file.endsWith('whoami.exe'))).toBe(true)
    }
  })

  it('returns 0 and never throws when icacls fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'fremkit-perm-'))
    const exec: AclExec = async (file) => {
      if (file.endsWith('icacls.exe')) throw new Error('denied')
      return { stdout: `"a","${SID}"` }
    }
    expect(await tightenDataDir(root, { platform: 'win32', exec })).toBe(0)
  })

  it('restrictToUser serves a single folder the same way', async () => {
    const { calls, exec } = fake(`"a","${SID}"`)
    expect(await restrictToUser('C:\\Users\\x\\AppData\\Local\\Fremkit', { platform: 'win32', exec, recurse: false })).toBe(true)
    expect(calls[1].args[0]).toBe('C:\\Users\\x\\AppData\\Local\\Fremkit')
  })

  it('logs a fixed code, never a SID or a name, for each way it can fail', async () => {
    root = await mkdtemp(join(tmpdir(), 'fremkit-perm-'))
    const ok = `"desktop-x\\secretname","${SID}"`
    const cases: Array<[string, AclExec, string]> = [
      ['acl-whoami-failed', async () => { throw new Error(`boom ${SID} secretname`) }, ''],
      ['acl-sid-invalid', async () => ({ stdout: '"secretname","S-1-5-18"' }), ''],
      ['acl-icacls-failed', async (file) => { if (file.endsWith('icacls.exe')) throw new Error(`denied ${SID}`); return { stdout: ok } }, ''],
      ['acl-icacls-partial', async (file) => ({ stdout: file.endsWith('icacls.exe') ? 'Successfully processed 3 files; Failed processing 2 files\r\n' : ok }), ''],
      ['acl-icacls-partial', async (file) => ({ stdout: file.endsWith('icacls.exe') ? '3 fichiers traités ; échec du traitement de 2 fichiers\r\n' : ok }), ''],
    ]
    for (const [code, exec] of cases) {
      const logged: string[] = []
      expect(await tightenDataDir(root, { platform: 'win32', exec, log: (c) => logged.push(c) })).toBe(0)
      expect(logged).toEqual([code])
      expect(JSON.stringify(logged)).not.toMatch(/S-1-5|secretname/)
    }
  })

  it('whoami rejecting means no icacls call', async () => {
    root = await mkdtemp(join(tmpdir(), 'fremkit-perm-'))
    const files: string[] = []
    const exec: AclExec = async (file) => { files.push(file); throw new Error('nope') }
    expect(await tightenDataDir(root, { platform: 'win32', exec })).toBe(0)
    expect(files).toEqual([windowsTool('whoami')])
  })

  it('a clean icacls summary logs nothing', async () => {
    root = await mkdtemp(join(tmpdir(), 'fremkit-perm-'))
    const logged: string[] = []
    const exec: AclExec = async (file) => ({ stdout: file.endsWith('icacls.exe') ? 'Successfully processed 1 files; Failed processing 0 files\r\n' : `"a","${SID}"` })
    expect(await tightenDataDir(root, { platform: 'win32', exec, log: (c) => logged.push(c) })).toBe(1)
    expect(logged).toEqual([])
  })

  it('never runs a program on darwin', async () => {
    root = await mkdtemp(join(tmpdir(), 'fremkit-perm-'))
    const { calls, exec } = fake('')
    await tightenDataDir(root, { platform: 'darwin', exec })
    expect(await restrictToUser(root, { platform: 'darwin', exec })).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

// The real thing, on Windows only: `icacls` lists the user and SYSTEM, and a file made later inherits it.
describe.skipIf(process.platform !== 'win32')('the data folder ACL, for real', () => {
  const aclOf = (path: string) => execFileSync(windowsTool('icacls'), [path], { encoding: 'utf8' })
  const principals = (out: string) => out.split(/\r?\n/).filter((l) => /:\(/.test(l)).map((l) => l.replace(/^.*?(\S+):\(.*$/, '$1'))

  it('leaves the user and SYSTEM only, and files created afterwards inherit it', async () => {
    root = await mkdtemp(join(tmpdir(), 'fremkit-perm-'))
    const data = join(root, 'data')
    await mkdir(data, { recursive: true })
    expect(await tightenDataDir(data)).toBe(1)
    const own = principals(aclOf(data))
    expect(own).toHaveLength(2)
    expect(own.some((p) => /SYSTEM$/i.test(p))).toBe(true)
    await writeFile(join(data, 'later.json'), '{}')
    const file = aclOf(join(data, 'later.json'))
    expect(principals(file)).toEqual(own)
    expect(file).toContain('(I)')
  })

  it('files and folders already there inherit it, and stay readable and writable (a second boot works)', async () => {
    root = await mkdtemp(join(tmpdir(), 'fremkit-perm-'))
    const data = join(root, 'data')
    await mkdir(join(data, 'sub'), { recursive: true })
    await writeFile(join(data, 'fremkit.json'), '{}')
    await writeFile(join(data, 'sub', 'x.json'), '{}')
    expect(await tightenDataDir(data)).toBe(1)
    expect(await tightenDataDir(data)).toBe(1)
    const own = principals(aclOf(data))
    expect(own).toHaveLength(2)
    for (const p of [join(data, 'fremkit.json'), join(data, 'sub'), join(data, 'sub', 'x.json')]) {
      const out = aclOf(p)
      expect(principals(out)).toEqual(own)
      expect(out).toContain('(I)')
    }
    await writeFile(join(data, 'fremkit.json'), '{"a":1}')
    await writeFile(join(data, 'sub', 'x.json'), '{"a":1}')
    expect(await readFile(join(data, 'fremkit.json'), 'utf8')).toBe('{"a":1}')
  })

  it('a token file already in the support folder keeps working after writeAccessToken', async () => {
    root = await mkdtemp(join(tmpdir(), 'fremkit-perm-'))
    const folder = join(root, 'support')
    await mkdir(folder)
    await writeFile(join(folder, 'access-1.token'), 'old')
    await writeAccessToken(join(folder, 'access-1.token'), 'new')
    await writeAccessToken(join(folder, 'access-2.token'), 'other')
    expect(await readFile(join(folder, 'access-1.token'), 'utf8')).toBe('new\n')
    expect(principals(aclOf(join(folder, 'access-1.token')))).toHaveLength(2)
  })

  it('runs when the server starts', async () => {
    root = await mkdtemp(join(tmpdir(), 'fremkit-perm-'))
    const data = join(root, 'data')
    const app = await buildApp({ accessToken: null, dataDir: data, widgetsDir: join(root, 'widgets'), uiDist: join(root, 'ui') })
    try {
      expect(principals(aclOf(data))).toHaveLength(2)
    } finally {
      await app.close()
    }
  })
})

describe('writeAccessToken on Windows', () => {
  const SID = 'S-1-5-21-1-2-3-1001'
  it('restricts the folder before the token exists, without walking it', async () => {
    root = await mkdtemp(join(tmpdir(), 'fremkit-perm-'))
    const folder = join(root, 'support')
    const path = join(folder, 'access-4242.token')
    const seen: Array<{ file: string; args: string[]; present: string[] }> = []
    const exec: AclExec = async (file, args) => {
      seen.push({ file, args, present: file.endsWith('icacls.exe') ? await readdir(folder) : [] })
      return { stdout: file.endsWith('icacls.exe') ? 'Successfully processed 1 files; Failed processing 0 files' : `"a","${SID}"` }
    }
    await writeAccessToken(path, 'tok', { platform: 'win32', exec })
    const icacls = seen.find((c) => c.file.endsWith('icacls.exe'))!
    expect(icacls.present).toEqual([])
    expect(icacls.args[0]).toBe(folder)
    expect(icacls.args).not.toContain('/T')
    expect((await readFile(path, 'utf8')).trim()).toBe('tok')
  })

  it('still writes the token, and logs the code, when the restriction fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'fremkit-perm-'))
    const path = join(root, 'support', 'access-4242.token')
    const logged: string[] = []
    const exec: AclExec = async () => { throw new Error(`x ${SID}`) }
    await writeAccessToken(path, 'tok', { platform: 'win32', exec, log: (c) => logged.push(c) })
    expect(logged).toEqual(['acl-whoami-failed'])
    expect((await readFile(path, 'utf8')).trim()).toBe('tok')
  })
})
