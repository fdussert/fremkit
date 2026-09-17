import type { Provider } from './types.js'
import { execCommand, type Exec } from './exec.js'

export const BATTERY_INTERVAL_MS = 30_000

export type BatteryKind = 'keyboard' | 'mouse' | 'trackpad' | 'headphones' | 'other'

export interface BatteryParts { left?: number; right?: number; case?: number }

export interface BatteryDevice {
  name: string
  kind: BatteryKind
  /** The figure the row draws: the single level, or the lowest of the parts. */
  percent: number
  parts?: BatteryParts
}

export interface MacBattery { percent: number; charging: boolean; minutesLeft?: number }

export interface BatterySnapshot {
  /** Absent on a Mac with no internal battery — a Mac mini, a Studio, a Mac Pro. */
  mac?: MacBattery
  devices: BatteryDevice[]
}

/**
 * The internal battery, from `pmset -g batt`.
 *
 * A desktop prints the power source and no battery line at all, which is a `null` rather than a
 * zero: "no battery" and "flat" must not look the same on the tile. `charged` and `AC attached;
 * not charging` are both plugged in and not charging, so only `charging` counts as charging.
 */
export function parsePmset(output: string): MacBattery | null {
  const line = /^\s*-\S*Battery\S*\s.*$/m.exec(output)?.[0]
  if (!line) return null
  const percent = /(\d+)%/.exec(line)
  if (!percent) return null
  const state = /%;\s*([^;]+?)\s*;/.exec(line)?.[1]?.toLowerCase() ?? ''
  const remaining = /(\d+):(\d{2})\s+remaining/.exec(line)
  const minutesLeft = remaining ? Number(remaining[1]) * 60 + Number(remaining[2]) : undefined
  return {
    percent: Number(percent[1]),
    charging: state === 'charging',
    // `0:00 remaining` is what a charged battery and a fresh estimate both print: not a countdown.
    ...(minutesLeft !== undefined && minutesLeft > 0 ? { minutesLeft } : {}),
  }
}

/** `AA:BB:CC:00:00:01` and `aa-bb-cc-00-00-01` are the same peripheral; this is the key both make. */
export function normalizeAddress(address: string | undefined): string {
  return (address ?? '').toLowerCase().replace(/[^0-9a-f]/g, '')
}

export interface IoregBattery { address: string; percent: number; product?: string; productId?: number }

/**
 * Battery-carrying HID peripherals, from `ioreg -r -l -n AppleDeviceManagementHIDEventService`.
 *
 * This is where a Magic Keyboard, Mouse or Trackpad keeps its charge; Bluetooth audio does not
 * appear here at all. On recent macOS the `Product` property of a Bluetooth peripheral comes back
 * empty, so the name is normally taken from `system_profiler` and matched on the address — the
 * product id is kept as the last resort for a device that is somehow not listed there.
 */
export function parseIoregBatteries(output: string): IoregBattery[] {
  const out: IoregBattery[] = []
  for (const record of output.split(/^\+-o /m).slice(1)) {
    // Every property sits on its own line, and `Product` is routinely present but empty — so the
    // gap either side of the `=` is spaces and tabs, never a newline, or an empty value would
    // swallow the next line's quoted string as its own.
    const percent = /"BatteryPercent"[ \t]*=[ \t]*(\d+)/.exec(record)
    if (!percent) continue
    const address = normalizeAddress(/"DeviceAddress"[ \t]*=[ \t]*"([^"\n]*)"/.exec(record)?.[1])
    if (!address) continue
    const product = /"Product"[ \t]*=[ \t]*"([^"\n]+)"/.exec(record)?.[1]
    const productId = /"ProductID"[ \t]*=[ \t]*(\d+)/.exec(record)?.[1]
    out.push({
      address,
      percent: Number(percent[1]),
      ...(product ? { product } : {}),
      ...(productId ? { productId: Number(productId) } : {}),
    })
  }
  return out
}

/** The Apple product ids of the peripherals whose name macOS no longer exposes through ioreg. */
const PRODUCT_NAMES: Record<number, string> = {
  0x0267: 'Magic Mouse',
  0x0269: 'Magic Mouse',
  0x0302: 'Magic Trackpad',
  0x0314: 'Magic Trackpad',
  0x0322: 'Magic Keyboard',
  0x0324: 'Magic Trackpad',
  0x029c: 'Magic Keyboard',
}

export function kindFor(name: string, minorType?: string): BatteryKind {
  const text = `${minorType ?? ''} ${name}`.toLowerCase()
  if (text.includes('trackpad')) return 'trackpad'
  if (text.includes('keyboard')) return 'keyboard'
  if (text.includes('mouse')) return 'mouse'
  if (/airpods|headphone|headset|earbud|beats|speaker/.test(text)) return 'headphones'
  return 'other'
}

export interface BluetoothDevice {
  name: string
  address: string
  minorType?: string
  percent?: number
  parts?: BatteryParts
}

/** `85`, `"85"` and `"85%"` all mean the same level; anything else is no reading at all. */
function percentOf(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const match = /(\d+)/.exec(value)
  return match ? Number(match[1]) : undefined
}

/**
 * Connected Bluetooth devices, from `system_profiler SPBluetoothDataType -json`.
 *
 * Each entry is an object with the device's name as its only key. The battery keys are optional
 * and vary by device — a single `…Main`, or the `…Left` / `…Right` / `…Case` trio of a set of
 * earbuds — and several Macs report none at all, which is why ioreg is read as well.
 */
export function parseBluetoothDevices(json: string): BluetoothDevice[] {
  let parsed: unknown
  try { parsed = JSON.parse(json) } catch { return [] }
  const sections = (parsed as { SPBluetoothDataType?: unknown[] })?.SPBluetoothDataType
  if (!Array.isArray(sections)) return []
  const out: BluetoothDevice[] = []
  for (const section of sections) {
    const connected = (section as { device_connected?: unknown })?.device_connected
    if (!Array.isArray(connected)) continue
    for (const entry of connected) {
      if (!entry || typeof entry !== 'object') continue
      for (const [name, raw] of Object.entries(entry as Record<string, unknown>)) {
        const info = (raw ?? {}) as Record<string, unknown>
        const parts: BatteryParts = {}
        const left = percentOf(info.device_batteryLevelLeft)
        const right = percentOf(info.device_batteryLevelRight)
        const caseLevel = percentOf(info.device_batteryLevelCase)
        if (left !== undefined) parts.left = left
        if (right !== undefined) parts.right = right
        if (caseLevel !== undefined) parts.case = caseLevel
        const main = percentOf(info.device_batteryLevelMain)
        out.push({
          name,
          address: normalizeAddress(typeof info.device_address === 'string' ? info.device_address : ''),
          ...(typeof info.device_minorType === 'string' ? { minorType: info.device_minorType } : {}),
          ...(main !== undefined ? { percent: main } : {}),
          ...(Object.keys(parts).length > 0 ? { parts } : {}),
        })
      }
    }
  }
  return out
}

/**
 * One row per peripheral that has a reading, names from Bluetooth and levels from either source.
 *
 * `system_profiler` wins on the level when it has one — it is the only source that knows about a
 * left earbud and a charging case — and ioreg covers the pointing devices it stays silent about.
 * The rows come out lowest first, so the one that needs charging is at the top of the tile.
 */
export function mergeBatteryDevices(bluetooth: BluetoothDevice[], ioreg: IoregBattery[]): BatteryDevice[] {
  const byAddress = new Map<string, BluetoothDevice>()
  for (const device of bluetooth) if (device.address) byAddress.set(device.address, device)

  const out: BatteryDevice[] = []
  const used = new Set<string>()

  const levelOf = (percent: number | undefined, parts: BatteryParts | undefined): number | undefined => {
    const values = Object.values(parts ?? {}).filter((v): v is number => typeof v === 'number')
    if (values.length > 0) return Math.min(...values)
    return percent
  }

  for (const device of bluetooth) {
    const percent = levelOf(device.percent, device.parts)
    if (percent === undefined) continue
    if (device.address) used.add(device.address)
    out.push({
      name: device.name,
      kind: kindFor(device.name, device.minorType),
      percent,
      ...(device.parts ? { parts: device.parts } : {}),
    })
  }

  for (const entry of ioreg) {
    if (used.has(entry.address)) continue
    used.add(entry.address)
    const known = byAddress.get(entry.address)
    const name = known?.name
      ?? entry.product
      ?? (entry.productId !== undefined ? PRODUCT_NAMES[entry.productId] : undefined)
      ?? 'Bluetooth'
    out.push({ name, kind: kindFor(name, known?.minorType), percent: entry.percent })
  }

  return out.sort((a, b) => a.percent - b.percent || a.name.localeCompare(b.name))
}

/**
 * The Mac's own battery and the charge of every Bluetooth peripheral that reports one.
 *
 * Polled slowly on purpose: `system_profiler` takes the better part of a second, and a battery
 * level moves by a point every few minutes. A command that fails — `pmset` on a machine without
 * one, `system_profiler` under a sandbox — costs its own section and not the whole snapshot.
 */
export function createBatteryProvider(exec: Exec = execCommand): Provider<BatterySnapshot> {
  const run = async (file: string, args: string[]): Promise<string> => {
    try { return await exec(file, args) } catch { return '' }
  }

  return {
    channel: 'battery',
    intervalMs: BATTERY_INTERVAL_MS,
    async poll(): Promise<BatterySnapshot> {
      const [pmset, bluetooth, ioreg] = await Promise.all([
        run('pmset', ['-g', 'batt']),
        run('system_profiler', ['SPBluetoothDataType', '-json']),
        run('ioreg', ['-r', '-l', '-n', 'AppleDeviceManagementHIDEventService']),
      ])
      const mac = parsePmset(pmset)
      const devices = mergeBatteryDevices(parseBluetoothDevices(bluetooth), parseIoregBatteries(ioreg))
      return { ...(mac ? { mac } : {}), devices }
    },
  }
}
