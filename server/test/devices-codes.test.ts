import { describe, expect, it } from 'vitest'
import { CODE_PROOF_ITERATIONS, codeProof } from '../src/devices/codeProof.js'
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  CODE_TTL_MS,
  MAX_WRONG_PER_MINUTE,
  MAX_WRONG_PER_MINUTE_TOTAL,
  PairingCodes,
  SECRET_PATTERN,
  peerKey,
} from '../src/devices/codes.js'

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t }
  return c
}

/** A code of the right shape that is not `code`. */
function other(code: string): string {
  return code === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA'
}

describe('PairingCodes', () => {
  it('exposes the agreed constants', () => {
    expect(CODE_ALPHABET).toBe('ABCDEFGHJKLMNPQRSTUVWXYZ23456789')
    expect(CODE_LENGTH).toBe(8)
    expect(CODE_TTL_MS).toBe(300_000)
    expect(MAX_WRONG_PER_MINUTE).toBe(5)
  })

  it('issues an 8-character code from the alphabet', () => {
    const c = clock()
    const codes = new PairingCodes(c.now)
    for (let i = 0; i < 50; i++) {
      const { code, expiresAt } = codes.issue()
      expect(code).toHaveLength(8)
      for (const ch of code) expect(CODE_ALPHABET).toContain(ch)
      expect(expiresAt).toBe(c.t + CODE_TTL_MS)
    }
  })

  it('accepts a code once', () => {
    const codes = new PairingCodes(clock().now)
    const { code } = codes.issue()
    expect(codes.consume(code)).toBe('ok')
    expect(codes.consume(code)).toBe('wrong')
  })

  it('reports an expired code', () => {
    const c = clock()
    const codes = new PairingCodes(c.now)
    const { code } = codes.issue()
    c.t += CODE_TTL_MS + 1
    expect(codes.consume(code)).toBe('expired')
  })

  it('accepts a code up to its last millisecond', () => {
    const c = clock()
    const codes = new PairingCodes(c.now)
    const { code } = codes.issue()
    c.t += CODE_TTL_MS
    expect(codes.consume(code)).toBe('ok')
  })

  it('invalidates the previous code when a new one is issued', () => {
    const codes = new PairingCodes(clock().now)
    const first = codes.issue().code
    let second = codes.issue().code
    while (second === first) second = codes.issue().code
    expect(codes.consume(first)).toBe('wrong')
    expect(codes.consume(second)).toBe('ok')
  })

  it('refuses everything after 5 wrong codes in a minute, then recovers', () => {
    const c = clock()
    const codes = new PairingCodes(c.now)
    const { code } = codes.issue()
    expect(codes.guessing()).toBe(false)
    for (let i = 0; i < MAX_WRONG_PER_MINUTE; i++) {
      expect(codes.consume(other(code))).toBe('wrong')
      c.t += 1_000
    }
    expect(codes.consume(code)).toBe('limited')
    expect(codes.guessing()).toBe(true)

    c.t += 60_000
    expect(codes.guessing()).toBe(false)
    expect(codes.consume(code)).toBe('ok')
  })

  it('counts a guess with no live code as wrong', () => {
    const codes = new PairingCodes(clock().now)
    for (let i = 0; i < MAX_WRONG_PER_MINUTE; i++) expect(codes.consume('AAAAAAAA')).toBe('wrong')
    expect(codes.consume('AAAAAAAA')).toBe('limited')
  })

  it('counts wrong codes per peer, so one guesser does not lock another out', () => {
    const c = clock()
    const codes = new PairingCodes(c.now)
    const { code } = codes.issue()
    for (let i = 0; i < MAX_WRONG_PER_MINUTE; i++) expect(codes.consume(other(code), '192.168.1.66')).toBe('wrong')
    expect(codes.consume(other(code), '192.168.1.66')).toBe('limited')
    expect(codes.consume(code, '192.168.1.66')).toBe('limited')
    expect(codes.guessing()).toBe(true)
    // The real iPad, on another address, still pairs.
    expect(codes.consume(code, '192.168.1.20')).toBe('ok')
  })

  it('refuses everyone once the total is spent, however many peers share it, then recovers', () => {
    const c = clock()
    const codes = new PairingCodes(c.now)
    const { code } = codes.issue()
    expect(MAX_WRONG_PER_MINUTE_TOTAL).toBe(60)
    for (let i = 0; i < MAX_WRONG_PER_MINUTE_TOTAL; i++) {
      expect(codes.consume(other(code), `10.8.${Math.floor(i / 4)}.${i % 4}`)).toBe('wrong')
    }
    expect(codes.consume(code, '192.168.1.20')).toBe('limited')
    expect(codes.guessing()).toBe(true)
    c.t += 60_000
    expect(codes.guessing()).toBe(false)
    expect(codes.consume(code, '192.168.1.20')).toBe('ok')
  })

  it('keys a peer by its IPv4 address, or by its IPv6 /64', () => {
    expect(peerKey('192.168.1.20')).toBe('192.168.1.20')
    expect(peerKey('::ffff:192.168.1.20')).toBe('192.168.1.20')
    expect(peerKey('::ffff:c0a8:114')).toBe('192.168.1.20')
    expect(peerKey('fd12:3456:789a:1:aaaa::1')).toBe(peerKey('fd12:3456:789a:1:bbbb:cccc:dddd:eeee'))
    // Link-local: one /64 for the whole link, so each address is its own peer.
    expect(peerKey('fe80::1%en0')).not.toBe(peerKey('fe80::abcd:1234'))
    expect(peerKey('fe80::1%en0')).toBe(peerKey('[FE80:0::1]'))
    expect(peerKey('fd12:3456:789a:1::1')).not.toBe(peerKey('fd12:3456:789a:2::1'))
  })

  it('gives one IPv6 host no more than one allowance, however many addresses it uses', () => {
    const codes = new PairingCodes(clock().now)
    const { code } = codes.issue()
    for (let i = 1; i <= MAX_WRONG_PER_MINUTE; i++) {
      expect(codes.consume(other(code), `fd12:3456:789a:1::${i.toString(16)}`)).toBe('wrong')
    }
    expect(codes.consume(code, 'fd12:3456:789a:1::ffff')).toBe('limited')
    expect(codes.consume(code, '[fd12:3456:789a:1:1234::9]')).toBe('limited')
    // Another network prefix, and IPv4, are other peers.
    expect(codes.consume(other(code), 'fd12:3456:789a:2::1')).toBe('wrong')
    expect(codes.consume(code, '192.168.1.20')).toBe('ok')
  })

  it('does not let one link-local guesser lock out another link-local peer', () => {
    const codes = new PairingCodes(clock().now)
    const { code } = codes.issue()
    for (let i = 0; i < MAX_WRONG_PER_MINUTE; i++) expect(codes.consume(other(code), 'fe80::bad%en0')).toBe('wrong')
    expect(codes.consume(other(code), 'fe80::bad%en0')).toBe('limited')
    expect(codes.consume(code, 'fe80::1c2d:3e4f:5a6b:7c8d%en0')).toBe('ok')
  })

  it('resets the total with a new code, but not a guesser\'s own window', () => {
    const c = clock()
    const codes = new PairingCodes(c.now)
    const first = codes.issue().code
    for (let i = 0; i < MAX_WRONG_PER_MINUTE; i++) expect(codes.consume(other(first), '10.9.9.9')).toBe('wrong')
    for (let i = MAX_WRONG_PER_MINUTE; i < MAX_WRONG_PER_MINUTE_TOTAL; i++) {
      expect(codes.consume(other(first), `10.8.${Math.floor(i / 4)}.${i % 4}`)).toBe('wrong')
    }
    expect(codes.consume(first, '192.168.1.20')).toBe('limited')
    const second = codes.issue().code
    // A guesser that spent its own allowance stays refused; the real iPad gets in.
    expect(codes.consume(second, '10.9.9.9')).toBe('limited')
    expect(codes.consume(second, '192.168.1.20')).toBe('ok')
  })

  it('is live only between a code being issued and it being used, cleared or expired', () => {
    const c = clock()
    const codes = new PairingCodes(c.now)
    expect(codes.hasLive()).toBe(false)
    const { code } = codes.issue()
    expect(codes.hasLive()).toBe(true)
    c.t += CODE_TTL_MS
    expect(codes.hasLive()).toBe(true)
    c.t += 1
    expect(codes.hasLive()).toBe(false)
    codes.issue()
    codes.clear()
    expect(codes.hasLive()).toBe(false)
    const next = codes.issue().code
    expect(codes.consume(next)).toBe('ok')
    expect(codes.hasLive()).toBe(false)
    expect(code).toHaveLength(8)
  })

  it('clear() drops the live code', () => {
    const codes = new PairingCodes(clock().now)
    const { code } = codes.issue()
    codes.clear()
    expect(codes.consume(code)).toBe('wrong')
  })
  describe('the QR secret', () => {
    /** A secret of the right shape that is not `secret`. */
    const otherSecret = (secret: string) => (secret.startsWith('A') ? 'B' : 'A').repeat(43)

    /** Spends the per-peer allowance of `address` and the total, from addresses in 10.8.0.0/16. */
    function exhaust(codes: PairingCodes, code: string, address: string): void {
      for (let i = 0; i < MAX_WRONG_PER_MINUTE; i++) expect(codes.consume(other(code), address)).toBe('wrong')
      for (let i = 0; i < MAX_WRONG_PER_MINUTE_TOTAL - MAX_WRONG_PER_MINUTE; i++) {
        expect(codes.consume(other(code), `10.8.${Math.floor(i / 4)}.${i % 4}`)).toBe('wrong')
      }
    }

    it('is 256 random bits in base64url, new with every code', () => {
      const codes = new PairingCodes(clock().now)
      const seen = new Set<string>()
      for (let i = 0; i < 20; i++) {
        const { secret } = codes.issue()
        expect(secret).toMatch(SECRET_PATTERN)
        expect(Buffer.from(secret, 'base64url')).toHaveLength(32)
        seen.add(secret)
      }
      expect(seen.size).toBe(20)
    })

    it('pairs while the code allowance is spent, from that peer and from everyone', () => {
      const codes = new PairingCodes(clock().now)
      const { code, secret } = codes.issue()
      exhaust(codes, code, '192.168.1.66')
      expect(codes.consume(code, '192.168.1.66')).toBe('limited')
      expect(codes.consume(code, '192.168.1.20')).toBe('limited')
      expect(codes.consumeSecret(secret, '192.168.1.66')).toBe('ok')
    })

    it('pairs after a flood of wrong secrets from many peers has spent the total', () => {
      const codes = new PairingCodes(clock().now)
      const { code, secret } = codes.issue()
      const peers = MAX_WRONG_PER_MINUTE_TOTAL / MAX_WRONG_PER_MINUTE
      expect(peers).toBeGreaterThanOrEqual(12)
      for (let p = 0; p < peers; p++) {
        for (let i = 0; i < MAX_WRONG_PER_MINUTE; i++) {
          expect(codes.consumeSecret(otherSecret(secret), `10.1.0.${p}`)).toBe('wrong')
        }
      }
      expect(codes.consumeSecret(otherSecret(secret), '10.1.1.1')).toBe('limited')
      expect(codes.consume(code, '192.168.1.20')).toBe('limited')
      expect(codes.consumeSecret(secret, '10.1.0.0')).toBe('ok')
    })

    it('fails a wrong secret as a wrong code: counted while allowed, refused once limited', () => {
      const codes = new PairingCodes(clock().now)
      const { code, secret } = codes.issue()
      for (let i = 0; i < MAX_WRONG_PER_MINUTE; i++) {
        expect(codes.consumeSecret(otherSecret(secret), '192.168.1.66')).toBe('wrong')
      }
      expect(codes.consumeSecret(otherSecret(secret), '192.168.1.66')).toBe('limited')
      expect(codes.consume(code, '192.168.1.66')).toBe('limited')
      expect(codes.guessing()).toBe(true)
      // The live code is untouched: another peer still pairs with it.
      expect(codes.consume(code, '192.168.1.20')).toBe('ok')
    })

    it('is single use, and spends the code with it', () => {
      const codes = new PairingCodes(clock().now)
      const { code, secret } = codes.issue()
      expect(codes.consumeSecret(secret)).toBe('ok')
      expect(codes.hasLive()).toBe(false)
      expect(codes.consumeSecret(secret)).toBe('wrong')
      expect(codes.consume(code)).toBe('wrong')
    })

    it('is spent when its code is', () => {
      const codes = new PairingCodes(clock().now)
      const { code, secret } = codes.issue()
      expect(codes.consume(code)).toBe('ok')
      expect(codes.consumeSecret(secret)).toBe('wrong')
    })

    it('dies with its code: a new code, clear(), expiry', () => {
      const c = clock()
      const codes = new PairingCodes(c.now)
      const first = codes.issue().secret
      const second = codes.issue().secret
      expect(codes.consumeSecret(first)).toBe('wrong')
      codes.clear()
      expect(codes.consumeSecret(second)).toBe('wrong')
      const third = codes.issue().secret
      c.t += CODE_TTL_MS + 1
      expect(codes.hasLive()).toBe(false)
      expect(codes.consumeSecret(third)).toBe('expired')
    })

    it('does not take the code for the secret, nor the secret for the code', () => {
      const codes = new PairingCodes(clock().now)
      const { code, secret } = codes.issue()
      expect(codes.consumeSecret(code)).toBe('wrong')
      expect(codes.consume(secret)).toBe('wrong')
      expect(codes.consumeSecret(secret)).toBe('ok')
    })
  })
})

describe('codeProof', () => {
  // The same vector as FremkitKit's CodeProofTests: both sides must derive the same proof.
  it('derives the proof the iPad sends for a typed code, bound to a key', () => {
    expect(CODE_PROOF_ITERATIONS).toBe(600_000)
    expect(codeProof('ABCDEFGH', 'n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg')).toBe('u0OmzfI4qjz-qNwuSnZEHpye4MAjcTzhT3jg2gJVid0')
    expect(codeProof('ABCDEFGH', 'n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgh')).not.toBe('u0OmzfI4qjz-qNwuSnZEHpye4MAjcTzhT3jg2gJVid0')
  })

  it('makes the live code pair only as its proof, never as itself', () => {
    const codes = new PairingCodes()
    const { code } = codes.issue((c) => codeProof(c, 'n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg'))
    expect(codes.consume(code, '192.0.2.1')).toBe('wrong')
    expect(codes.consume(codeProof(code, 'n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgh'), '192.0.2.1')).toBe('wrong')
    expect(codes.consume(codeProof(code, 'n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg'), '192.0.2.1')).toBe('ok')
  })
})
