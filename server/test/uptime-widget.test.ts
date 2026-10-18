import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vite-plus/test'

interface UptimeReading {
  uptimeSeconds?: number | null
  error?: string
}

function loadWidget(locale = 'fr') {
  const html = readFileSync(new URL('../../widgets/uptime/index.html', import.meta.url), 'utf8')
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1]
  if (!script) throw new Error('Uptime widget script is missing')

  const elements = new Map<string, { textContent: string }>()
  const callbacks: {
    data?: (reading: UptimeReading) => void
    locale?: () => void
  } = {}
  const channels: string[] = []
  const api = {
    locale,
    t: (value: Record<string, string>) => value[api.locale] ?? value.en,
    whenReady: (callback: () => void) => callback(),
    subscribe: (channel: string, callback: (reading: UptimeReading) => void) => {
      channels.push(channel)
      callbacks.data = callback
    },
    onLocale: (callback: () => void) => { callbacks.locale = callback },
  }
  const document = {
    documentElement: { lang: 'en' },
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, { textContent: '' })
      return elements.get(id)!
    },
  }
  runInNewContext(script, { Fremkit: api, document })

  return {
    elements,
    channels,
    update: (reading: UptimeReading) => callbacks.data?.(reading),
    language: (next: string) => {
      api.locale = next
      callbacks.locale?.()
    },
  }
}

describe('Uptime widget', () => {
  it.each([
    [0, '0 min'],
    [59, '0 min'],
    [3600, '1 h 0 min'],
    [90061, '1 j 1 h 1 min'],
    [260213, '3 j 0 h 16 min'],
  ])('formats %s seconds as %s', (seconds, expected) => {
    const widget = loadWidget()
    widget.update({ uptimeSeconds: seconds })
    expect(widget.channels).toEqual(['system'])
    expect(widget.elements.get('value')?.textContent).toBe(expected)
  })

  it('shows loading and missing readings explicitly', () => {
    const widget = loadWidget()
    expect(widget.elements.get('note')?.textContent).toBe('Chargement…')
    widget.update({ uptimeSeconds: null })
    expect(widget.elements.get('value')?.textContent).toBe('?')
    expect(widget.elements.get('note')?.textContent).toBe('Indisponible')
  })

  it('marks the last measurement stale on error and recovers', () => {
    const widget = loadWidget()
    widget.update({ uptimeSeconds: 90061 })
    widget.update({ error: 'offline' })
    expect(widget.elements.get('value')?.textContent).toBe('1 j 1 h 1 min')
    expect(widget.elements.get('note')?.textContent).toBe('Données anciennes')
    widget.update({ uptimeSeconds: 60 })
    expect(widget.elements.get('value')?.textContent).toBe('1 min')
    expect(widget.elements.get('note')?.textContent).toBe('Depuis le dernier démarrage')
  })

  it('updates the day unit and explanation on language change', () => {
    const widget = loadWidget()
    widget.update({ uptimeSeconds: 90061 })
    widget.language('en')
    expect(widget.elements.get('value')?.textContent).toBe('1 d 1 h 1 min')
    expect(widget.elements.get('note')?.textContent).toBe('Since the last system boot')
  })
})
