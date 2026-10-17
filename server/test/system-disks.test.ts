import { describe, expect, it } from 'vite-plus/test'
import { normalizeDisks } from '../src/providers/system.js'

describe('Mac disk availability', () => {
  it('prefers APFS Data and reconciles used and available bytes', () => {
    const disks = normalizeDisks([
      { mount: '/', size: 1000, used: 50, available: 300, use: 10 },
      { mount: '/System/Volumes/Data', size: 1000, used: 650, available: 300, use: 68 },
      { mount: '/Volumes/External', size: 500, used: 10, available: 450, use: 2 },
    ])
    expect(disks).toEqual([
      { mount: '/', size: 1000, used: 700, available: 300, use: 70 },
      { mount: '/Volumes/External', size: 500, used: 10, available: 450, use: 2 },
    ])
  })

  it('folds the volumes of one APFS container into one row', () => {
    const disks = normalizeDisks([
      { fs: '/dev/disk3s1s1', type: 'APFS', mount: '/', size: 1000, used: 15, available: 160, use: 9 },
      { fs: '/dev/disk3s2', type: 'APFS', mount: '/System/Volumes/Preboot', size: 1000, used: 11, available: 160, use: 7 },
      { fs: '/dev/disk3s5', type: 'APFS', mount: '/System/Volumes/Data', size: 1000, used: 745, available: 160, use: 82 },
      { fs: '/dev/disk3s7', type: 'APFS', mount: '/Volumes/Dev', size: 1000, used: 63, available: 160, use: 28 },
      { fs: '/dev/disk6s2', type: 'exfat', mount: '/Volumes/X10', size: 4000, used: 986, available: 3014, use: 25 },
    ])
    expect(disks).toEqual([
      {
        mount: '/', size: 1000, used: 840, available: 160, use: 84,
        volumes: [{ mount: '/', used: 745 }, { mount: '/Volumes/Dev', used: 63 }],
      },
      { mount: '/Volumes/X10', size: 4000, used: 986, available: 3014, use: 25 },
    ])
  })

  it('folds two volumes of an external APFS disk, and keeps other file systems apart', () => {
    const disks = normalizeDisks([
      { fs: '/dev/disk5s1', type: 'APFS', mount: '/Volumes/Photos', size: 2000, used: 700, available: 1000, use: 41 },
      { fs: '/dev/disk5s2', type: 'APFS', mount: '/Volumes/Backup', size: 2000, used: 300, available: 1000, use: 23 },
      { fs: '/dev/disk7s1', type: 'msdos', mount: '/Volumes/A', size: 100, used: 10, available: 90, use: 10 },
      { fs: '/dev/disk7s2', type: 'msdos', mount: '/Volumes/B', size: 100, used: 20, available: 80, use: 20 },
      { fs: '//guest@nas.example.com/share', type: 'smbfs', mount: '/Volumes/share', size: 50, used: 5, available: 45, use: 10 },
    ])
    expect(disks.map((disk) => [disk.mount, disk.used, 'volumes' in disk])).toEqual([
      ['/Volumes/Photos', 1000, true],
      ['/Volumes/A', 10, false],
      ['/Volumes/B', 20, false],
      ['/Volumes/share', 5, false],
    ])
  })

  it('leaves unreported free space unknown', () => {
    expect(normalizeDisks([{ mount: '/', size: 1000, used: 50, use: 5 }])[0].available).toBeNull()
  })
})
