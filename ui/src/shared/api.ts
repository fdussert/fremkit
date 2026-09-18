import type { Config, ConnectionSummary, ConnectionTypeInfo, InstalledAppInfo, MarketplaceResponse, PickOption, WidgetPermissionSet, WidgetsResponse } from './types'

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
  pages: number
  backgrounds: number
  reenterSecrets: { id: string; name: string; type: string }[]
}
export type ConnectionTestResult = { ok: true; detail: string } | { ok: false; error: string }

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { const b = await res.json(); if (b.errors) msg = b.errors.join('\n'); else if (b.error) msg = b.error } catch {}
    throw new Error(msg)
  }
  return res.json()
}

async function empty(res: Response): Promise<void> {
  if (res.ok) return
  let msg = `HTTP ${res.status}`
  try { const b = await res.json(); if (b.errors) msg = b.errors.join('\n'); else if (b.error) msg = b.error } catch { /* no body */ }
  throw new Error(msg)
}

export const api = {
  getConfig: () => fetch('/api/config').then((r) => json<Config>(r)),
  getStatus: () => fetch('/api/config/status').then((r) => json<{ degraded: boolean }>(r)),
  putConfig: (cfg: Config) => fetch('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg) }).then((r) => json<Config>(r)),
  getWidgets: () => fetch('/api/widgets').then((r) => json<WidgetsResponse>(r)),
  rescan: () => fetch('/api/widgets/rescan', { method: 'POST' }).then((r) => json<WidgetsResponse>(r)),
  /** `data` is the raw file base64-encoded; the server answers with the name it stored it under. */
  uploadBackground: (name: string, data: string) =>
    fetch('/api/backgrounds', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, data }) })
      .then((r) => json<{ name: string }>(r)),
  deleteBackground: (name: string) =>
    fetch(`/api/backgrounds/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),

  /** The registry index merged with what this machine has installed. Never throws on offline. */
  getMarketplace: () => fetch('/api/marketplace').then((r) => json<MarketplaceResponse>(r)),
  refreshMarketplace: () =>
    fetch('/api/marketplace/refresh', { method: 'POST' }).then((r) => json<MarketplaceResponse>(r)),
  /**
   * `consent` says the permission dialog was answered, not that something is allowed: the
   * server recomputes the difference from the package it downloads and refuses either way.
   */
  installWidget: async (id: string, opts: { consent?: WidgetPermissionSet | false; version?: string; update?: boolean } = {}) => {
    const res = await fetch(`/api/marketplace/${opts.update ? 'update' : 'install'}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, consent: opts.consent ?? false, ...(opts.version ? { version: opts.version } : {}) }),
    })
    if (res.status === 409) {
      const body = await res.json().catch(() => null) as { errors?: string[]; newPermissions?: WidgetPermissionSet } | null
      const message = body?.errors?.join('\n') ?? `HTTP ${res.status}`
      if (body?.newPermissions) throw new ConsentRequiredError(message, body.newPermissions)
      throw new Error(message)
    }
    return json<{ ok: true; id: string; version: string }>(res)
  },
  uninstallWidget: (id: string) =>
    fetch('/api/marketplace/uninstall', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
    }).then((r) => json<{ ok: true; id: string }>(r)),
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
  /** Replaces the dashboard with the one in `file`. The archive carries no secrets. */
  restoreBackup: (file: File) =>
    fetch('/api/restore', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: file })
      .then((r) => json<RestoreResult>(r)),

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
}
