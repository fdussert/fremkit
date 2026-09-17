import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  createBatteryProvider,
  kindFor,
  mergeBatteryDevices,
  normalizeAddress,
  parseBluetoothDevices,
  parseIoregBatteries,
  parsePmset,
  type BatterySnapshot,
} from '../src/providers/battery.js'

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
const IOREG = fixture('ioreg-hid.txt')
const BLUETOOTH = fixture('bluetooth.json')

describe('pmset', () => {
  it('reads a discharging battery with its estimate', () => {
    const out = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234567)\t57%; discharging; 3:21 remaining present: true\n"
    expect(parsePmset(out)).toEqual({ percent: 57, charging: false, minutesLeft: 201 })
  })
  it('reads a charging battery', () => {
    const out = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234567)\t80%; charging; 1:12 remaining present: true\n"
    expect(parsePmset(out)).toEqual({ percent: 80, charging: true, minutesLeft: 72 })
  })
  it('does not call AC attached charging, and drops a 0:00 estimate', () => {
    const out = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234567)\t80%; AC attached; not charging present: true\n"
    expect(parsePmset(out)).toEqual({ percent: 80, charging: false })
    const charged = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234567)\t100%; charged; 0:00 remaining present: true\n"
    expect(parsePmset(charged)).toEqual({ percent: 100, charging: false })
  })
  it('handles no estimate yet, and a desktop with no battery at all', () => {
    const out = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234567)\t92%; discharging; (no estimate) present: true\n"
    expect(parsePmset(out)).toEqual({ percent: 92, charging: false })
    expect(parsePmset("Now drawing from 'AC Power'\n")).toBeNull()
    expect(parsePmset('')).toBeNull()
  })
})

describe('ioreg', () => {
  it('keeps only the records that carry a battery and an address', () => {
    expect(parseIoregBatteries(IOREG)).toEqual([
      { address: 'aabbcc000001', percent: 99, productId: 802 },
      { address: 'aabbcc000002', percent: 15, productId: 804 },
      { address: 'aabbcc000003', percent: 64, product: 'Wireless Mouse', productId: 12345 },
    ])
    expect(parseIoregBatteries('')).toEqual([])
  })
  it('normalises the two spellings of a MAC address to one key', () => {
    expect(normalizeAddress('aa-bb-cc-00-00-01')).toBe(normalizeAddress('AA:BB:CC:00:00:01'))
    expect(normalizeAddress(undefined)).toBe('')
  })
})

describe('system_profiler', () => {
  it('reads the connected devices and their battery keys', () => {
    const devices = parseBluetoothDevices(BLUETOOTH)
    expect(devices.map((d) => d.name)).toEqual(['Magic Keyboard', 'Magic Trackpad', 'Wireless Earbuds', 'Game Controller', 'Silent Speaker'])
    expect(devices[2]).toEqual({
      name: 'Wireless Earbuds',
      address: 'aabbcc000004',
      minorType: 'Headphones',
      parts: { left: 72, right: 68, case: 100 },
    })
    expect(devices[3].percent).toBe(45)
    expect(devices[4].percent).toBeUndefined()
  })
  it('returns nothing for malformed or empty output', () => {
    expect(parseBluetoothDevices('not json')).toEqual([])
    expect(parseBluetoothDevices('{}')).toEqual([])
  })
})

describe('kinds', () => {
  it('classifies from the minor type and from the name', () => {
    expect(kindFor('Magic Trackpad', 'Magic Trackpad')).toBe('trackpad')
    expect(kindFor('Magic Keyboard', 'Keyboard')).toBe('keyboard')
    expect(kindFor('Wireless Mouse')).toBe('mouse')
    expect(kindFor('AirPods Pro')).toBe('headphones')
    expect(kindFor('Game Controller', 'Gamepad')).toBe('other')
  })
})

describe('merge', () => {
  it('names the ioreg peripherals from Bluetooth and sorts the lowest first', () => {
    const devices = mergeBatteryDevices(parseBluetoothDevices(BLUETOOTH), parseIoregBatteries(IOREG))
    expect(devices).toEqual([
      { name: 'Magic Trackpad', kind: 'trackpad', percent: 15 },
      { name: 'Game Controller', kind: 'other', percent: 45 },
      { name: 'Wireless Mouse', kind: 'mouse', percent: 64 },
      { name: 'Wireless Earbuds', kind: 'headphones', percent: 68, parts: { left: 72, right: 68, case: 100 } },
      { name: 'Magic Keyboard', kind: 'keyboard', percent: 99 },
    ])
  })
  it('falls back to the product id when the peripheral is not listed over Bluetooth', () => {
    expect(mergeBatteryDevices([], [{ address: 'aabbcc000001', percent: 99, productId: 802 }])).toEqual([
      { name: 'Magic Keyboard', kind: 'keyboard', percent: 99 },
    ])
    expect(mergeBatteryDevices([], [{ address: 'aabbcc0000ff', percent: 40 }])).toEqual([
      { name: 'Bluetooth', kind: 'other', percent: 40 },
    ])
  })
})

describe('battery provider', () => {
  it('polls the three commands and assembles the snapshot', async () => {
    const exec = vi.fn(async (file: string) => {
      if (file === 'pmset') return "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; charging; 1:00 remaining present: true\n"
      if (file === 'system_profiler') return BLUETOOTH
      if (file === 'ioreg') return IOREG
      return ''
    })
    const snapshot = (await createBatteryProvider(exec).poll!()) as BatterySnapshot
    expect(snapshot.mac).toEqual({ percent: 80, charging: true, minutesLeft: 60 })
    expect(snapshot.devices).toHaveLength(5)
    expect(exec).toHaveBeenCalledWith('system_profiler', ['SPBluetoothDataType', '-json'])
    expect(exec).toHaveBeenCalledWith('ioreg', ['-r', '-l', '-n', 'AppleDeviceManagementHIDEventService'])
  })
  it('loses only the failing section when a command refuses', async () => {
    const exec = vi.fn(async (file: string) => {
      if (file === 'ioreg') return IOREG
      throw new Error('command not found')
    })
    const snapshot = (await createBatteryProvider(exec).poll!()) as BatterySnapshot
    expect(snapshot.mac).toBeUndefined()
    expect(snapshot.devices.map((d) => d.percent)).toEqual([15, 64, 99])
  })
})
