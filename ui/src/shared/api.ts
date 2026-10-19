import type { Config, ConnectionSummary, ExportPreview, ImportPreview, LayoutScope, ConnectionTypeInfo, InstalledAppInfo, MarketplaceResponse, PickOption, WidgetPermissionSet, WidgetsResponse } from './types'

/**
 * The install was refused because the package asks for something the dialog did not show.
 *
 * A distinct class rather than a message, because the answer carries the difference and the
 * caller has to reopen the dialog on *that* — which is the honest path when the index entry and
 * the package inside the zip disagree about what the widget wants.
 */
export class ConsentRequiredError extends Error {
  constructor(message: string, readonly newPermissions: WidgetPermissionSet) {
    super(message)
    this.name = 'ConsentRequiredError'
  }
}

export interface ConnectionInput { type: string; name: string; fields: Record<string, string>; secrets?: Record<string, string> }

/** What `POST /api/restore` answers: what landed, and whose secret has to be typed in again. */
export interface RestoreResult {
  ok: true
  /** Pages over every screen. */
  pages: number
  screens: number
  backgrounds: number
  tileIcons: number
  reenterSecrets: { id: string; name: string; type: string }[]
}
/** Which part of the dashboard a shared layout holds, and the free-text settings ticked into it. */
export interface LayoutRequest { scope: LayoutScope; screen?: string; page?: string; include?: string[] }
/** What changed between a version and the one before it (`server/src/config/history-diff.ts`). */
export interface HistorySummary {
  first?: true
  screensAdded: string[]
  screensRemoved: string[]
  screensRenamed: { from: string; to: string }[]
  pagesAdded: { screen: string; name: string }[]
  pagesRemoved: { screen: string; name: string }[]
  pagesRenamed: { screen: string; from: string; to: string }[]
  widgetsAdded: string[]
  widgetsRemoved: string[]
  widgetsMoved: number
  widgetsEdited: number
  theme?: { from: string; to: string }
  screensEdited: string[]
  other: boolean
}
export type HistoryKind = 'save' | 'earlier' | 'before-migration' | 'restore' | 'import' | 'revert'
/** One saved version of the dashboard, as `GET /api/history` lists it, newest first. */
export interface HistoryEntry {
  id: string
  at: number
  savedAt: number
  kind: HistoryKind
  summary: HistorySummary
  revertedTo?: number
}
/** What `POST /api/history/:id/restore` answers. */
export interface HistoryRestoreResult {
  ok: true
  pages: number
  screens: number
  reenterSecrets: { id: string; name: string; type: string }[]
}
export type ConnectionTestResult = { ok: true; detail: string } | { ok: false; error: string }

/** What every paired device carries: never its token, nor the token's hash. */
interface PublicDeviceBase {
  id: string
  name: string
  /** ISO date. */
  pairedAt: string
  /** ISO date, written at most once a minute; null until the device first connects. */
  lastSeen: string | null
}
export interface PublicIpadDevice extends PublicDeviceBase {
  kind: 'ipad'
  viewport: { width: number; height: number }
  screenId: string | null
}
export interface PublicExtensionDevice extends PublicDeviceBase {
  kind: 'extension'
  origin: string
  installId: string
  /** Whether the extension's socket is open right now. */
  connected: boolean
}
/** A paired device as `GET /api/devices` lists it. */
export type PublicDevice = PublicIpadDevice | PublicExtensionDevice
/** What `GET /api/devices` answers: the remote listener's state and the paired devices. */
export interface DeviceStatus {
  enabled: boolean
  listening: boolean
  error: 'portInUse' | null
  /** Someone is trying codes: the code is refused until the minute ends. */
  guessing: boolean
  host: string | null
  addresses: string[]
  port: number
  keyHash: string | null
  /** Four words from the key's hash, null before a key exists. */
  fingerprint: string[] | null
  devices: PublicDevice[]
  /** A browser extension waiting for an answer (the Edge shows it too); never carries a token. */
  companionRequest: CompanionRequest | null
  /** Extension pairing locked after too many wrong codes, until unlocked in Devices. */
  companionLocked?: boolean
}
/** `extension`: the first characters of the asking extension's id, to tell it from another. */
export interface CompanionRequest { requestId: string; code: string; name: string; extension?: string; expiresAt: number }

/** The first characters of an extension origin's id, as the server gives them with a request. */
export function shortExtensionId(origin: string): string {
  return origin.replace(/^chrome-extension:\/\//, '').slice(0, 6)
}
/** A pairing code, its expiry (epoch ms) and the QR payload carrying it. */
export interface PairingOffer { code: string; expiresAt: number; url: string }

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { const b = await res.json(); if (b.errors) msg = b.errors.join('\n'); else if (b.error) msg = b.error } catch {}
    throw new Error(msg)
  }
  return res.json()
}

/** A refused request whose status the caller may act on; `message` is the server's text. */
export interface HttpFailure extends Error { status: number }

async function empty(res: Response): Promise<void> {
  if (res.ok) return
  let msg = `HTTP ${res.status}`
  try { const b = await res.json(); if (b.errors) msg = b.errors.join('\n'); else if (b.error) msg = b.error } catch { /* no body */ }
  throw Object.assign(new Error(msg), { status: res.status }) satisfies HttpFailure
}

export const api = {
  getConfig: () => fetch('/api/config').then((r) => json<Config>(r)),
  /** The redacted report for a bug issue, as Markdown text (see `server/src/diagnostics`). */
  getDiagnostics: async (): Promise<string> => {
    const res = await fetch('/api/diagnostics', { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.text()
  },
  getStatus: () => fetch('/api/config/status').then((r) => json<{ degraded: boolean }>(r)),
  putConfig: (cfg: Config) => fetch('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg) }).then((r) => json<Config>(r)),
  getWidgets: () => fetch('/api/widgets').then((r) => json<WidgetsResponse>(r)),
  rescan: () => fetch('/api/widgets/rescan', { method: 'POST' }).then((r) => json<WidgetsResponse>(r)),
  /** Asks every page showing screen `id` to reload (`server/src/config/screen-reload.ts`). */
  reloadScreen: (id: string) => fetch(`/api/screens/${encodeURIComponent(id)}/reload`, { method: 'POST' }).then(empty),
  /** `data` is the raw file base64-encoded; the server answers with the name it stored it under. */
  uploadBackground: (name: string, data: string) =>
    fetch('/api/backgrounds', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, data }) })
      .then((r) => json<{ name: string }>(r)),
  deleteBackground: (name: string) =>
    fetch(`/api/backgrounds/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),
  /** The icons imported for tile titles, sorted. */
  listTileIcons: () => fetch('/api/tile-icons').then((r) => json<{ names: string[] }>(r)),
  /** `data` is the raw file base64-encoded; the server answers with the name it stored it under. */
  uploadTileIcon: (name: string, data: string) =>
    fetch('/api/tile-icons', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, data }) })
      .then((r) => json<{ name: string }>(r)),
  /** A 404 is a success: the icon is already gone, which is what the caller asked for. */
  deleteTileIcon: (name: string) =>
    fetch(`/api/tile-icons/${encodeURIComponent(name)}`, { method: 'DELETE' })
      .then((r) => (r.status === 404 ? { ok: true } : json<{ ok: boolean }>(r))),

  /** The registry index merged with what this machine has installed. Never throws on offline. */
  getMarketplace: () => fetch('/api/marketplace').then((r) => json<MarketplaceResponse>(r)),
  refreshMarketplace: () =>
    fetch('/api/marketplace/refresh', { method: 'POST' }).then((r) => json<MarketplaceResponse>(r)),
  /**
   * `consent` says the permission dialog was answered, not that something is allowed: the
   * server recomputes the difference from the package it downloads and refuses either way.
   */
  installWidget: async (id: string, opts: { consent?: WidgetPermissionSet | false; version?: string; update?: boolean; kind?: 'widget' | 'theme' } = {}) => {
    const res = await fetch(`/api/marketplace/${opts.update ? 'update' : 'install'}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id, kind: opts.kind ?? 'widget', consent: opts.consent ?? false,
        ...(opts.version ? { version: opts.version } : {}),
      }),
    })
    if (res.status === 409) {
      const body = await res.json().catch(() => null) as { errors?: string[]; newPermissions?: WidgetPermissionSet } | null
      const message = body?.errors?.join('\n') ?? `HTTP ${res.status}`
      if (body?.newPermissions) throw new ConsentRequiredError(message, body.newPermissions)
      throw new Error(message)
    }
    return json<{ ok: true; id: string; version: string }>(res)
  },
  /**
   * Removes a widget or a theme.
   *
   * The answer names the connections the widget's declared type owned: they are *not* deleted —
   * a credential the user entered is theirs to keep, and reinstalling finds it where it was —
   * so the admin can offer to delete them, which is a second decision and a second request.
   */
  uninstallWidget: (id: string, kind: 'widget' | 'theme' = 'widget') =>
    fetch('/api/marketplace/uninstall', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, kind }),
    }).then((r) => json<{ ok: true; id: string; connections?: { id: string; name: string }[] }>(r)),
  /**
   * Updates every waiting widget at once. Answers 200 with one result per widget even when some
   * failed, so the caller paints them per row rather than showing the first error.
   */
  updateAllWidgets: (consent: Record<string, WidgetPermissionSet | false>) =>
    fetch('/api/marketplace/update-all', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consent }),
    }).then((r) => json<{ results: { id: string; ok: boolean; version?: string; error?: string; newPermissions?: WidgetPermissionSet }[] }>(r)),
  /**
   * Installs every registry widget a screen already places and this machine does not have.
   *
   * Same answer shape as `updateAllWidgets`, and the same rule: which widgets those are is the
   * server's answer from its own config, not a list the client gets to choose.
   */
  installMissingWidgets: (consent: Record<string, WidgetPermissionSet | false>) =>
    fetch('/api/marketplace/install-missing', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consent }),
    }).then((r) => json<{ results: { id: string; ok: boolean; version?: string; error?: string; newPermissions?: WidgetPermissionSet }[] }>(r)),

  /**
   * Lets a widget use a connection that belongs to another widget's declared type, or stops it.
   *
   * No copy is made: the id is recorded on the widget's consent record, so there is one
   * credential in one place and revoking is deleting one line.
   */
  shareConnection: (id: string, connectionId: string, allow: boolean) =>
    fetch('/api/marketplace/share', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, connectionId, allow }),
    }).then((r) => json<{ ok: true; id: string; connectionId: string; allow: boolean }>(r)),

  /** The applications installed on this machine, for the fields a manifest marks `suggest: apps`. */
  getInstalledApps: () => fetch('/api/apps/installed').then((r) => json<InstalledAppInfo[]>(r)),

  /**
   * Downloads the whole dashboard as a zip.
   *
   * Through a hidden anchor rather than `fetch`: the answer carries
   * `Content-Disposition: attachment`, so the browser saves it and the page stays where it is.
   */
  downloadBackup: (): void => {
    const a = document.createElement('a')
    a.href = '/api/backup'
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  },
  /**
   * What a shared layout would hold, and what it leaves out: the file with its images as sizes,
   * and the report the export dialog draws.
   */
  previewLayout: (req: LayoutRequest) =>
    fetch('/api/share/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) })
      .then((r) => json<ExportPreview>(r)),
  /** The address the layout file downloads from: an attachment, saved like the backup. */
  layoutUrl: (req: LayoutRequest): string => {
    const q = new URLSearchParams({ scope: req.scope })
    if (req.screen) q.set('screen', req.screen)
    if (req.page) q.set('page', req.page)
    if (req.include?.length) q.set('include', req.include.join(','))
    return `/api/share/export?${q.toString()}`
  },
  /** Downloads the layout file, through a hidden anchor as `downloadBackup` does. */
  downloadLayout: (req: LayoutRequest): void => {
    const a = document.createElement('a')
    a.href = api.layoutUrl(req)
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  },
  /** The layout file as text, for the clipboard when a download is not possible. */
  layoutText: (req: LayoutRequest) => fetch(api.layoutUrl(req)).then(async (r) => {
    if (!r.ok) await json<never>(r)
    return r.text()
  }),
  /** Reads a layout file somebody wrote: what may be applied, and what to ask about. Writes nothing. */
  readLayout: (file: unknown) =>
    fetch('/api/share/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(file) })
      .then((r) => json<ImportPreview>(r)),
  /** Replaces the dashboard with the one in `file`. The archive carries no secrets. */
  restoreBackup: (file: File) =>
    fetch('/api/restore', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: file })
      .then((r) => json<RestoreResult>(r)),

  /** The saved versions of the dashboard, newest first. */
  getHistory: () => fetch('/api/history', { cache: 'no-store' }).then((r) => json<{ entries: HistoryEntry[] }>(r)),
  getHistoryVersion: (id: string) =>
    fetch(`/api/history/${encodeURIComponent(id)}`, { cache: 'no-store' }).then((r) => json<{ entry: HistoryEntry; config: Config }>(r)),
  /** Puts a version back; a save of its own, so the one it replaces stays in the history. */
  restoreHistory: (id: string) =>
    fetch(`/api/history/${encodeURIComponent(id)}/restore`, { method: 'POST' }).then((r) => json<HistoryRestoreResult>(r)),

  getConnectionTypes: () => fetch('/api/connections/types').then((r) => json<ConnectionTypeInfo[]>(r)),
  getConnections: () => fetch('/api/connections').then((r) => json<ConnectionSummary[]>(r)),
  putConnection: (id: string, body: ConnectionInput) =>
    fetch(`/api/connections/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => json<ConnectionSummary>(r)),
  deleteConnection: (id: string) =>
    fetch(`/api/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(empty),
  /** The choices a `pick` setting offers, read live from the device behind the connection. */
  getConnectionOptions: (id: string, source: string) =>
    fetch(`/api/connections/${encodeURIComponent(id)}/options?source=${encodeURIComponent(source)}`)
      .then((r) => json<PickOption[]>(r)),
  testConnection: (id: string, body: Partial<ConnectionInput>) =>
    fetch(`/api/connections/${encodeURIComponent(id)}/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => json<ConnectionTestResult>(r)),

  /**
   * Refuse the browser extension's pairing request the Edge is showing, with the code on show: the
   * server answers 409 when that is no longer the waiting request's code. There is no approve:
   * typing the code into the extension is the approval.
   */
  /** Settings → Devices' Unlock pairing, after too many wrong codes locked it. */
  unlockCompanion: () => fetch('/api/companion/unlock', { method: 'POST' }).then(empty),
  refuseCompanion: (requestId: string, code: string) =>
    fetch(`/api/companion/requests/${encodeURIComponent(requestId)}/refuse`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
    }).then(empty),
  getDevices: () => fetch('/api/devices').then((r) => json<DeviceStatus>(r)),
  /** Answers the status after the switch; on `portInUse` the switch stays off and `message` says why. */
  setDevicesEnabled: (enabled: boolean) =>
    fetch('/api/devices/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) })
      .then((r) => json<DeviceStatus & { message?: string }>(r)),
  /** A fresh single-use code; the previous one stops working. Refused (409) while pairing is off. */
  newPairingCode: () => fetch('/api/devices/code', { method: 'POST' }).then((r) => json<PairingOffer>(r)),
  patchDevice: (id: string, patch: { name?: string; screenId?: string | null }) =>
    fetch(`/api/devices/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
      .then((r) => json<PublicDevice>(r)),
  deleteDevice: (id: string) => fetch(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(empty),
  deleteAllDevices: () => fetch('/api/devices', { method: 'DELETE' }).then(empty),
  /** A new TLS key: every paired device is removed with it, since each pinned the old one. */
  resetDeviceCertificate: () => fetch('/api/devices/reset-certificate', { method: 'POST' }).then((r) => json<DeviceStatus>(r)),
  /** Screen → Brightness: places matching a city name, through the server (Open-Meteo). Only on Search. */
  searchPlaces: (q: string, lang: 'fr' | 'en') =>
    fetch(`/api/brightness/places?q=${encodeURIComponent(q)}&lang=${lang}`)
      .then((r) => json<{ places: { name: string; detail: string; latitude: number; longitude: number }[] }>(r)),
}
