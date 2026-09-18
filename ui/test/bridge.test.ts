import { describe, expect, it } from 'vitest'
import { FrameTrust, fetchTarget, nonEmptyString, stampInstance } from '../src/shared/widgetMessages'

describe('nonEmptyString', () => {
  it('accepts a non-empty string and nothing else', () => {
    expect(nonEmptyString('volume')).toBe('volume')
    for (const value of ['', null, undefined, 42, {}, [], true, ['volume']]) {
      expect(nonEmptyString(value), JSON.stringify(value)).toBeNull()
    }
  })
})

describe('stampInstance', () => {
  it('overwrites whatever instanceId the widget wrote', () => {
    // The attack: a widget declaring `shortcuts` names another instance's id and presses its
    // saved buttons. The ids are guessable — a known prefix and four random characters.
    expect(stampInstance({ instanceId: 'shortcuts-victim', index: 0 }, 'shortcuts-mine'))
      .toEqual({ instanceId: 'shortcuts-mine', index: 0 })
  })
  it('adds one when the widget sent none', () => {
    expect(stampInstance({ index: 3 }, 'sc-1')).toEqual({ index: 3, instanceId: 'sc-1' })
    expect(stampInstance({}, 'sc-1')).toEqual({ instanceId: 'sc-1' })
  })
  it('keeps every other field', () => {
    expect(stampInstance({ index: 1, extra: 'kept' }, 'sc-1'))
      .toEqual({ index: 1, extra: 'kept', instanceId: 'sc-1' })
  })
  it('passes a payload that is not a plain object through for the server to refuse', () => {
    for (const payload of [null, undefined, 'nope', 42, [1, 2]]) {
      expect(stampInstance(payload, 'sc-1'), JSON.stringify(payload)).toBe(payload)
    }
  })
  it('does not mutate what the widget sent', () => {
    const original = { instanceId: 'theirs', index: 0 }
    stampInstance(original, 'mine')
    expect(original.instanceId).toBe('theirs')
  })
})

describe('fetchTarget', () => {
  it('accepts a GET, stated or implied', () => {
    expect(fetchTarget({ url: 'https://api.example.com/x' })).toBe('https://api.example.com/x')
    expect(fetchTarget({ url: 'https://a.example/', init: {} })).toBe('https://a.example/')
    expect(fetchTarget({ url: 'https://a.example/', init: { method: 'GET' } })).toBe('https://a.example/')
    expect(fetchTarget({ url: 'https://a.example/', init: null })).toBe('https://a.example/')
  })
  it('refuses any other method rather than turning it into a GET', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'get', 'Get']) {
      expect(fetchTarget({ url: 'https://a.example/', init: { method } }), method).toBeNull()
    }
  })
  it('refuses a method that is not even a string, which used to pass as GET', () => {
    for (const method of [1, true, {}, ['GET'], null]) {
      expect(fetchTarget({ url: 'https://a.example/', init: { method } }), JSON.stringify(method)).toBeNull()
    }
  })
  it('refuses a missing or non-string url', () => {
    for (const url of [undefined, '', 42, {}, null]) {
      expect(fetchTarget({ url }), JSON.stringify(url)).toBeNull()
    }
  })
  it('refuses an init that is not an object', () => {
    expect(fetchTarget({ url: 'https://a.example/', init: 'GET' })).toBeNull()
    expect(fetchTarget({ url: 'https://a.example/', init: ['GET'] })).toBeNull()
  })
})

describe('FrameTrust', () => {
  const SRC = '/widgets/clock/index.html'

  it('trusts the first load', () => {
    const trust = new FrameTrust()
    expect(trust.trusted).toBe(true)
    trust.onLoad(SRC)
    expect(trust.trusted).toBe(true)
  })

  it('disowns a second load of the same src: the document navigated itself', () => {
    const trust = new FrameTrust()
    trust.onLoad(SRC)
    trust.onLoad(SRC)
    expect(trust.trusted).toBe(false)
  })

  it('trusts a load the host caused by pointing the frame at another widget', () => {
    const trust = new FrameTrust()
    trust.onLoad(SRC)
    trust.onLoad('/widgets/weather/index.html')
    expect(trust.trusted).toBe(true)
  })

  it('trusts a brand-new element with the same src, which is what a rescan makes', () => {
    // A manifest that disappears and comes back recreates the element behind the v-if. That
    // first load used to look exactly like a self-navigation, and the frame stayed disowned.
    const trust = new FrameTrust()
    trust.onLoad(SRC)
    trust.onLoad(SRC)
    expect(trust.trusted).toBe(false)
    trust.reset()
    trust.onLoad(SRC)
    expect(trust.trusted).toBe(true)
  })

  it('disowns again if the new document also navigates itself', () => {
    const trust = new FrameTrust()
    trust.reset()
    trust.onLoad(SRC)
    trust.onLoad(SRC)
    expect(trust.trusted).toBe(false)
  })

  it('treats a missing src as its own value rather than throwing', () => {
    const trust = new FrameTrust()
    trust.onLoad(null)
    expect(trust.trusted).toBe(true)
    trust.onLoad(null)
    expect(trust.trusted).toBe(false)
  })
})
