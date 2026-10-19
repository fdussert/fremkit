import { ref, type Ref } from 'vue'
import { t } from './i18n'
import { deviceUnauthorized, isRemotePage } from './remote'

type Cb = (data: unknown) => void
export interface Socket {
  status: Ref<'connecting' | 'open' | 'closed'>
  subscribe(channel: string, cb: Cb): () => void
  command(channel: string, name: string, payload?: unknown): Promise<unknown>
}

let instance: Socket | null = null

export function useSocket(): Socket {
  if (instance) return instance
  const status = ref<'connecting' | 'open' | 'closed'>('connecting')
  const subs = new Map<string, Set<Cb>>()
  const last = new Map<string, unknown>()
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let ws: WebSocket | null = null
  let seq = 0
  let retryMs = 500

  /**
   * A socket that will not reopen may mean the server no longer takes this page's cookie: it
   * was restarted with a new access secret. The handshake does not say so — a refused upgrade
   * is just a close — so a plain request asks, and a 401 reloads the page once. In the helper's
   * windows the reload picks up the new cookie; in a browser it lands on the server's page
   * explaining how to get back in, which has no script and so cannot loop.
   *
   * A paired device has no access secret to pick up: its 401 means it was revoked, so it raises
   * the shared flag the dashboard shows instead of reloading.
   */
  let reloading = false
  const checkSession = () => {
    if (reloading) return
    fetch('/api/config/status', { cache: 'no-store' })
      .then((res) => {
        if (res.status !== 401 || reloading) return
        if (isRemotePage()) { deviceUnauthorized.value = true; return }
        reloading = true; location.reload()
      })
      .catch(() => { /* the server is down: the reconnect loop handles that */ })
  }

  const send = (msg: unknown) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)) }

  function connect() {
    status.value = 'connecting'
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/ws`)
    ws.onopen = () => {
      status.value = 'open'; retryMs = 500
      for (const ch of subs.keys()) send({ type: 'subscribe', channel: ch })
    }
    ws.onmessage = (ev) => {
      let m: { type?: string; channel?: string; data?: unknown; id?: string; result?: unknown; error?: string }
      try { m = JSON.parse(ev.data) }
      catch { console.warn('socket: invalid JSON message', ev.data); return }
      if (m.type === 'data' && m.channel) { last.set(m.channel, m.data); subs.get(m.channel)?.forEach((cb) => cb(m.data)) }
      // A provider can retire a channel while widgets remain subscribed. Do not replay its old snapshot.
      else if (m.type === 'invalidate' && m.channel) last.delete(m.channel)
      else if (m.type === 'result' || m.type === 'error') {
        if (!m.id) return
        const p = pending.get(m.id)
        if (!p) return
        pending.delete(m.id)
        m.type === 'result' ? p.resolve(m.result) : p.reject(new Error(m.error ?? t('socket.unknownError')))
      }
    }
    ws.onclose = () => {
      status.value = 'closed'
      // Invalidation messages may have been missed; wait for fresh data after reconnect.
      last.clear()
      for (const p of pending.values()) p.reject(new Error(t('socket.lost')))
      pending.clear()
      checkSession()
      setTimeout(connect, retryMs)
      retryMs = Math.min(retryMs * 2, 10_000)
    }
    ws.onerror = () => ws?.close()
  }
  connect()

  instance = {
    status,
    subscribe(channel, cb) {
      let set = subs.get(channel)
      if (!set) { set = new Set(); subs.set(channel, set); send({ type: 'subscribe', channel }) }
      set.add(cb)
      if (last.has(channel)) cb(last.get(channel))
      return () => {
        set!.delete(cb)
        if (set!.size === 0) { subs.delete(channel); last.delete(channel); send({ type: 'unsubscribe', channel }) }
      }
    },
    command(channel, name, payload) {
      return new Promise((resolve, reject) => {
        const id = 'c' + (++seq)
        pending.set(id, { resolve, reject })
        send({ type: 'command', id, channel, name, payload })
      })
    },
  }
  return instance
}
