import type { PublicFetch } from '../net/pinned.js'
import { wander } from './world.js'

/**
 * The network, as demo mode sees it: the two Open-Meteo endpoints the weather widget asks the
 * proxy for, answered from here, and nothing else.
 *
 * Handed to the proxy in place of `publicFetch`, so a widget's request goes through every check
 * the proxy makes — granted host, scheme, size — and ends here instead of on the wire. Any other
 * host gets a 503, the answer a widget already handles as "offline". The declared-connection
 * proxy gets `demoConnectionFetch` (`declared.ts`) instead: invented LAN devices, no network.
 */
export function demoPublicFetch(now: () => number = Date.now): PublicFetch {
  return async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'geocoding-api.open-meteo.com' && url.pathname === '/v1/search') return json(geocode(url))
    if (url.hostname === 'api.open-meteo.com' && url.pathname === '/v1/forecast') return json(forecast(url, now()))
    return new Response(JSON.stringify({ error: 'demo mode: no network' }), { status: 503, headers: { 'content-type': 'application/json' } })
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** Whatever city is asked for exists, at a fixed spot, under the name it was asked by. */
function geocode(url: URL): unknown {
  const name = (url.searchParams.get('name') ?? '').trim().slice(0, 60)
  if (!name) return { results: [] }
  const pretty = name.charAt(0).toUpperCase() + name.slice(1)
  return { results: [{ name: pretty, latitude: 48.85, longitude: 2.35 }] }
}

/** `YYYY-MM-DDTHH:MM` in local time, which is how Open-Meteo answers with `timezone=auto`. */
function localIso(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** Partly cloudy, clear, overcast, light rain, clear: WMO codes the widget draws. */
const DAY_CODES = [2, 1, 3, 61, 0, 2, 1]

function forecast(url: URL, t: number): unknown {
  const fahrenheit = url.searchParams.get('temperature_unit') === 'fahrenheit'
  const mph = url.searchParams.get('wind_speed_unit') === 'mph'
  const temp = (c: number): number => Math.round((fahrenheit ? c * 9 / 5 + 32 : c) * 10) / 10
  const startOfHour = Math.floor(t / HOUR) * HOUR
  const midnight = new Date(t)
  midnight.setHours(0, 0, 0, 0)
  // Warmest mid-afternoon, coolest before dawn, drifting a little from one day to the next.
  const at = (ms: number): number => {
    const hour = new Date(ms).getHours() + new Date(ms).getMinutes() / 60
    return 15 + 6 * Math.sin((hour - 9) / 24 * 2 * Math.PI) + wander(ms, 0, 1.5, 3 * DAY)
  }
  const hourly = { time: [] as string[], temperature_2m: [] as number[], weather_code: [] as number[], precipitation_probability: [] as number[] }
  for (let h = 0; h < 4 * 24; h++) {
    const ms = midnight.getTime() + h * HOUR
    const day = Math.floor(h / 24)
    const hour = h % 24
    const code = DAY_CODES[day % DAY_CODES.length]
    hourly.time.push(localIso(ms))
    hourly.temperature_2m.push(temp(at(ms)))
    // A mix through the day rather than one code: the clear glyph is a sun, which looks wrong
    // on a row of night hours, so a capture taken at night gets clouds in it too.
    hourly.weather_code.push(code === 61 ? 61 : [2, 3, 2, 1][Math.floor(hour / 3) % 4])
    hourly.precipitation_probability.push(code === 61 ? 60 + (hour % 4) * 5 : hour > 15 && hour < 19 ? 20 : 0)
  }
  const daily = { time: [] as string[], weather_code: [] as number[], temperature_2m_max: [] as number[], temperature_2m_min: [] as number[] }
  for (let d = 0; d < 4; d++) {
    const ms = midnight.getTime() + d * DAY
    daily.time.push(localIso(ms).slice(0, 10))
    daily.weather_code.push(DAY_CODES[d % DAY_CODES.length])
    daily.temperature_2m_max.push(temp(at(ms + 15 * HOUR) + 1))
    daily.temperature_2m_min.push(temp(at(ms + 4 * HOUR) - 1))
  }
  return {
    latitude: 48.85, longitude: 2.35,
    current: {
      time: localIso(startOfHour),
      temperature_2m: temp(at(t)),
      apparent_temperature: temp(at(t) - 1.4),
      weather_code: DAY_CODES[0],
      wind_speed_10m: Math.round((mph ? 0.621 : 1) * wander(t, 14, 4, 40 * 60_000)),
      relative_humidity_2m: Math.round(wander(t, 62, 8, 3 * HOUR)),
    },
    hourly,
    daily,
  }
}
