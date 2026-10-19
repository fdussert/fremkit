import { describe, it, expect } from 'vitest'
import { Socket } from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { FastifyRequest } from 'fastify'
import { isLocalRequest, isRemoteRequest, markRemoteSocket, pairedDeviceOf } from '../src/net/remote.js'
import { isTrusted } from '../src/providers/types.js'
import { ClaudeTracker } from '../src/claude/tracker.js'
import { createClaudeSessionsProvider } from '../src/claude/providers.js'
import { tr } from '../src/i18n.js'

/**
 * Local or remote is decided by the socket a request arrived on, never by its address alone: a
 * paired device reaches the server through a listener whose sockets are marked, and a marked
 * socket stays remote even if what it reports as its address looks like this machine.
 */

const fastifyRequest = (ip: string, socket = new Socket(), deviceId?: string | null): FastifyRequest =>
  ({ ip, raw: { socket }, ...(deviceId !== undefined ? { deviceId } : {}) }) as unknown as FastifyRequest

describe('remote request identity', () => {
  it('judges a request on a marked socket remote, even from a loopback address', () => {
    const socket = new Socket()
    markRemoteSocket(socket)
    const req = fastifyRequest('127.0.0.1', socket)
    expect(isRemoteRequest(req)).toBe(true)
    expect(isLocalRequest(req)).toBe(false)
  })

  it('judges an unmarked loopback request local, and a LAN address not', () => {
    expect(isLocalRequest(fastifyRequest('127.0.0.1'))).toBe(true)
    expect(isLocalRequest(fastifyRequest('192.0.2.10'))).toBe(false)
  })

  it('reads the socket of a raw IncomingMessage too', () => {
    const socket = new Socket()
    const raw = { socket } as unknown as IncomingMessage
    expect(isRemoteRequest(raw)).toBe(false)
    markRemoteSocket(socket)
    expect(isRemoteRequest(raw)).toBe(true)
  })

  it('knows no paired device until a gate attaches one', () => {
    expect(pairedDeviceOf(fastifyRequest('192.0.2.10'))).toBeNull()
    expect(pairedDeviceOf(fastifyRequest('192.0.2.10', new Socket(), null))).toBeNull()
    expect(pairedDeviceOf(fastifyRequest('192.0.2.10', new Socket(), 'device-1'))).toBe('device-1')
  })
})

describe('isTrusted', () => {
  it('trusts a local caller and a paired one, and nothing without a context', () => {
    expect(isTrusted({ loopback: true, paired: false })).toBe(true)
    expect(isTrusted({ loopback: false, paired: true })).toBe(true)
    expect(isTrusted({ loopback: false, paired: false })).toBe(false)
    expect(isTrusted(undefined)).toBe(false)
  })
})

describe('commands from a paired device', () => {
  const paired = { loopback: false, paired: true, deviceId: 'device-1' }
  const provider = () => createClaudeSessionsProvider(new ClaudeTracker(), {
    focusRunner: async () => {},
    soundRunner: async () => {},
  })

  it('still refuses claude.preview: it plays a sound on the Mac, not on the device', async () => {
    const out = await provider().commands!.preview({ value: 'none' }, paired)
    expect(out).toEqual({ ok: false, error: tr(undefined, 'provider.localOnly') })
  })

  it('lets claude.focus past the locality guard', async () => {
    const out = await provider().commands!.focus({ sessionId: 'nope' }, paired)
    expect(out).toEqual({ ok: false, reason: 'unknownSession' })
  })
})
