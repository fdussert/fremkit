import { describe, expect, it, vi } from 'vitest'
import { cachedDisks, parseDf, parseMountTypes, parseSwap, parseVmStat, readDisks, readMemory, type Exec } from '../src/providers/mac-readings.js'

const DF = `Filesystem     1024-blocks      Used  Available Capacity  Mounted on
/dev/disk3s1s1   971298980  13339460  139561248     9%    /
devfs                  369       369          0   100%    /dev
/dev/disk3s5     971298980 742941172  139561248    85%    /System/Volumes/Data
map auto_home            0         0          0   100%    /System/Volumes/Data/home
/dev/disk5s1    3906985984 963005440 2943980544    25%    /Volumes/My Backup
//user@192.0.2.10/share  1000  400  600  40%  /Volumes/share
`

const MOUNT = `/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
devfs on /dev (devfs, local, nobrowse)
/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)
/dev/disk5s1 on /Volumes/My Backup (exfat, local, nodev, nosuid, noowners)
`

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               12345.
Pages active:                            500000.
Pages purgeable:                           1000.
Pages wired down:                        200000.
Anonymous pages:                         600000.
Pages occupied by compressor:             50000.
`

describe('disks without blocking', () => {
  it('reads df like systeminformation: devices and shares, spaces kept, sizes in bytes', () => {
    const disks = parseDf(DF, parseMountTypes(MOUNT))
    expect(disks.map((d) => d.mount)).toEqual(['/', '/System/Volumes/Data', '/Volumes/My Backup', '/Volumes/share'])
    const data = disks[1]
    expect(data).toEqual({
      fs: '/dev/disk3s5', type: 'apfs', mount: '/System/Volumes/Data',
      size: 971298980 * 1024, used: 742941172 * 1024, available: 139561248 * 1024,
      use: Number((100 * 742941172 / (742941172 + 139561248)).toFixed(2)),
    })
    expect(disks[2].type).toBe('exfat')
    expect(disks[3].type).toBeUndefined()
  })

  it('runs df and mount by their absolute paths, and does without mount', async () => {
    const exec = vi.fn<Exec>(async (file) => {
      if (file === '/sbin/mount') throw new Error('denied')
      return { stdout: DF }
    })
    const disks = await readDisks(exec)
    expect(exec.mock.calls.map(([file]) => file).sort()).toEqual(['/bin/df', '/sbin/mount'])
    expect(disks).toHaveLength(4)
  })

  it('reads at most once a minute, shares a reading in flight, and retries after a failure', async () => {
    let t = 0
    const read = vi.fn(async () => [])
    const get = cachedDisks(read, 60_000, () => t)
    await Promise.all([get(), get()])
    t = 59_000
    await get()
    expect(read).toHaveBeenCalledTimes(1)
    t = 60_000
    await get()
    expect(read).toHaveBeenCalledTimes(2)

    const failing = vi.fn().mockRejectedValueOnce(new Error('df')).mockResolvedValue([])
    const again = cachedDisks(failing, 60_000, () => 0)
    await expect(again()).rejects.toThrow('df')
    await again()
    expect(failing).toHaveBeenCalledTimes(2)
  })
})

describe('memory without blocking', () => {
  it('takes the page size from vm_stat itself', () => {
    const p = parseVmStat(VM_STAT)
    expect(p).toEqual({ wired: 200000 * 16384, compressed: 50000 * 16384, purgeable: 1000 * 16384, anonymous: 600000 * 16384 })
  })

  it('reads swap in megabytes, with a comma or a dot', () => {
    expect(parseSwap('total = 2048.00M  used = 1023,50M  free = 1024.50M  (encrypted)')).toEqual({
      swaptotal: 2048 * 1024 * 1024, swapused: 1023.5 * 1024 * 1024,
    })
  })

  it('computes active and available as systeminformation does', async () => {
    const exec: Exec = async (file) => ({ stdout: file === '/usr/bin/vm_stat' ? VM_STAT : 'total = 0.00M  used = 0.00M  free = 0.00M' })
    const total = 64 * 2 ** 30
    const free = 2 * 2 ** 30
    const m = await readMemory(exec, total, free)
    const active = (600000 - 1000 + 200000 + 50000) * 16384
    expect(m).toEqual({ total, free, used: total - free, active, available: free + (total - free - active), swaptotal: 0, swapused: 0 })
  })
})
