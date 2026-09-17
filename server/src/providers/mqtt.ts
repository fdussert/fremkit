import mqtt from 'mqtt'

export interface MqttMessage { topic: string; payload: string }

/**
 * The slice of an MQTT client this codebase uses.
 *
 * Narrow on purpose: the Bambu provider is driven entirely through this interface, so its tests
 * inject a fake printer instead of opening a socket.
 */
export interface MqttClientLike {
  onConnect(cb: () => void): void
  onMessage(cb: (message: MqttMessage) => void): void
  /** Called on every disconnection, with the error when there was one. */
  onClose(cb: (err?: Error) => void): void
  subscribe(topic: string): void
  publish(topic: string, payload: string): void
  end(): void
}

export interface MqttOptions { host: string; port: number; username: string; password: string; clientId: string }
export type MqttConnect = (opts: MqttOptions) => MqttClientLike

/** TLS port of the printer's local broker. */
export const BAMBU_PORT = 8883

export function bambuClientId(): string {
  return `fremkit-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Real client.
 *
 * `rejectUnauthorized: false` is required: the printer serves a self-signed certificate for its
 * own IP, and there is no CA to pin it to. The link is still encrypted and stays on the LAN.
 * `reconnectPeriod: 0` disables the library's own retry loop, because the provider owns the
 * backoff and needs to know about every disconnection.
 */
export const connectMqtt: MqttConnect = (opts) => {
  const client = mqtt.connect(`mqtts://${opts.host}:${opts.port}`, {
    username: opts.username,
    password: opts.password,
    clientId: opts.clientId,
    rejectUnauthorized: false,
    reconnectPeriod: 0,
    connectTimeout: 10_000,
  })
  let closed = false
  return {
    onConnect: (cb) => { client.on('connect', cb) },
    onMessage: (cb) => { client.on('message', (topic, payload) => cb({ topic, payload: payload.toString('utf8') })) },
    onClose: (cb) => {
      // `error` and `close` both fire on a failed connection; collapse them into one call.
      const once = (err?: Error) => { if (closed) return; closed = true; cb(err) }
      client.on('error', once)
      client.on('close', () => once())
    },
    subscribe: (topic) => { client.subscribe(topic) },
    publish: (topic, payload) => { client.publish(topic, payload) },
    end: () => { closed = true; client.end(true) },
  }
}
