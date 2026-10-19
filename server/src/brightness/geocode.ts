/**
 * Finding a place's coordinates for the day/night schedule, from a city name the user typed.
 *
 * The only network call brightness ever makes, and only when the user presses "Search" in
 * Screen → Brightness: the sun times themselves are computed on this Mac (`schedule.ts`). The
 * service is Open-Meteo's geocoder, the one the weather widget already uses — free, no account,
 * no key. Nothing but the query and the language leaves the Mac; nothing of the answer is kept
 * but the latitude and longitude the user picks, saved with the screen.
 */

import { z } from 'zod'
import { readJsonCapped } from '../net/json.js'
import { USER_AGENT } from '../version.js'

export const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search'
export const GEOCODE_TIMEOUT_MS = 8000
/** Results offered to pick from. */
export const GEOCODE_COUNT = 6
/** A name longer than this is not a place. */
export const MAX_QUERY_LENGTH = 100
const MAX_ANSWER_BYTES = 256 * 1024

export const PlaceQuerySchema = z.object({
  q: z.string().trim().min(2).max(MAX_QUERY_LENGTH),
  lang: z.enum(['fr', 'en']).default('en'),
})

/** One answer, reduced to what the admin shows and saves. */
export interface Place {
  name: string
  /** Region and country, for telling two Saint-Denis apart. */
  detail: string
  latitude: number
  longitude: number
}

const AnswerSchema = z.object({
  results: z.array(z.object({
    name: z.string().max(200),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    admin1: z.string().max(200).optional(),
    country: z.string().max(200).optional(),
  }).loose()).max(50).optional(),
}).loose()

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

export class GeocodeError extends Error {}

export async function searchPlaces(query: string, lang: 'fr' | 'en', fetchImpl: Fetch = fetch): Promise<Place[]> {
  const url = new URL(GEOCODE_URL)
  url.searchParams.set('name', query)
  url.searchParams.set('count', String(GEOCODE_COUNT))
  url.searchParams.set('language', lang)
  url.searchParams.set('format', 'json')
  let res: Response
  try {
    res = await fetchImpl(url.toString(), {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
      redirect: 'error',
    })
  } catch {
    throw new GeocodeError('unreachable')
  }
  if (!res.ok) throw new GeocodeError(`status ${res.status}`)
  const parsed = AnswerSchema.safeParse(await readJsonCapped(res, MAX_ANSWER_BYTES).catch(() => null))
  if (!parsed.success) throw new GeocodeError('unexpected answer')
  return (parsed.data.results ?? []).slice(0, GEOCODE_COUNT).map((r) => ({
    name: r.name,
    detail: [r.admin1, r.country].filter((x): x is string => !!x && x !== r.name).join(', '),
    latitude: Math.round(r.latitude * 10000) / 10000,
    longitude: Math.round(r.longitude * 10000) / 10000,
  }))
}
