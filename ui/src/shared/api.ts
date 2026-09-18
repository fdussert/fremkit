import type { Config, ConnectionSummary, ConnectionTypeInfo, InstalledAppInfo, PickOption, WidgetsResponse } from './types'

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
