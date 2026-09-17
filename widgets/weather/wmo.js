/**
 * WMO weather interpretation codes (the `weather_code` Open-Meteo returns) mapped to a glyph and a
 * localised label. Kept out of index.html so the mapping can be unit tested on its own: the file
 * is a plain script, loaded with a <script> tag in the widget and evaluated against a scope object
 * in the test, so it needs no module system either side.
 */
;(function (root) {
  'use strict'

  /** Inner markup of a 24x24 stroked SVG, in the same style as the admin's Lucide subset. */
  var GLYPHS = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/>',
    'sun-cloud': '<path d="M12 2v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="M20 12h2"/><path d="m19.1 4.9-1.4 1.4"/><path d="M15.9 12.7A4 4 0 0 0 10 8.5"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/>',
    cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9Z"/>',
    fog: '<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2"/><path d="M16 17H7"/><path d="M17 21H9"/>',
    drizzle: '<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2"/><path d="M8 19v1"/><path d="M8 15v1"/><path d="M16 19v1"/><path d="M16 15v1"/><path d="M12 21v1"/><path d="M12 17v1"/>',
    rain: '<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2"/><path d="M8 15v6"/><path d="M16 15v6"/><path d="M12 17v5"/>',
    snow: '<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2"/><path d="M8 16h.01"/><path d="M8 20h.01"/><path d="M12 18h.01"/><path d="M12 22h.01"/><path d="M16 16h.01"/><path d="M16 20h.01"/>',
    thunder: '<path d="M6 16.3A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 .5 9"/><path d="m13 12-3 5h4l-3 5"/>',
  }

  /**
   * One entry per code the API documents. Codes it does not document fall back to `cloud` with an
   * "unknown" label rather than drawing nothing, so an unexpected value still reads as weather.
   */
  var CODES = {
    0: ['sun', { fr: 'Ciel dégagé', en: 'Clear sky' }],
    1: ['sun-cloud', { fr: 'Peu nuageux', en: 'Mainly clear' }],
    2: ['sun-cloud', { fr: 'Partiellement nuageux', en: 'Partly cloudy' }],
    3: ['cloud', { fr: 'Couvert', en: 'Overcast' }],
    45: ['fog', { fr: 'Brouillard', en: 'Fog' }],
    48: ['fog', { fr: 'Brouillard givrant', en: 'Rime fog' }],
    51: ['drizzle', { fr: 'Bruine faible', en: 'Light drizzle' }],
    53: ['drizzle', { fr: 'Bruine', en: 'Drizzle' }],
    55: ['drizzle', { fr: 'Bruine dense', en: 'Dense drizzle' }],
    56: ['drizzle', { fr: 'Bruine verglaçante', en: 'Freezing drizzle' }],
    57: ['drizzle', { fr: 'Bruine verglaçante dense', en: 'Dense freezing drizzle' }],
    61: ['rain', { fr: 'Pluie faible', en: 'Light rain' }],
    63: ['rain', { fr: 'Pluie', en: 'Rain' }],
    65: ['rain', { fr: 'Pluie forte', en: 'Heavy rain' }],
    66: ['rain', { fr: 'Pluie verglaçante', en: 'Freezing rain' }],
    67: ['rain', { fr: 'Pluie verglaçante forte', en: 'Heavy freezing rain' }],
    71: ['snow', { fr: 'Neige faible', en: 'Light snow' }],
    73: ['snow', { fr: 'Neige', en: 'Snow' }],
    75: ['snow', { fr: 'Neige forte', en: 'Heavy snow' }],
    77: ['snow', { fr: 'Grains de neige', en: 'Snow grains' }],
    80: ['rain', { fr: 'Averses faibles', en: 'Light showers' }],
    81: ['rain', { fr: 'Averses', en: 'Showers' }],
    82: ['rain', { fr: 'Averses violentes', en: 'Violent showers' }],
    85: ['snow', { fr: 'Averses de neige', en: 'Snow showers' }],
    86: ['snow', { fr: 'Fortes averses de neige', en: 'Heavy snow showers' }],
    95: ['thunder', { fr: 'Orage', en: 'Thunderstorm' }],
    96: ['thunder', { fr: 'Orage et grêle', en: 'Thunderstorm with hail' }],
    99: ['thunder', { fr: 'Orage et forte grêle', en: 'Thunderstorm with heavy hail' }],
  }

  var UNKNOWN = { key: 'cloud', label: { fr: 'Temps inconnu', en: 'Unknown weather' } }

  /** `{ key, label }` for a WMO code; the label is a `{ fr, en }` table `Fremkit.t()` resolves. */
  function describe(code) {
    var entry = CODES[code]
    if (!entry) return UNKNOWN
    return { key: entry[0], label: entry[1] }
  }

  /** A standalone SVG for a glyph key, drawn in the current text colour. */
  function svg(key, size) {
    var body = GLYPHS[key] || GLYPHS.cloud
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>'
  }

  /**
   * The upcoming hours of an Open-Meteo `hourly` block. The API returns whole local days starting
   * at midnight, so the slice starts at the first entry strictly after `nowIso` — the response's
   * own `current.time`, which is already in the location's time zone, rather than a clock this
   * widget would have to convert.
   */
  function upcomingHours(hourly, nowIso, count) {
    if (!hourly || !Array.isArray(hourly.time)) return []
    var out = []
    for (var i = 0; i < hourly.time.length && out.length < count; i++) {
      if (hourly.time[i] <= nowIso) continue
      out.push({
        time: hourly.time[i],
        temperature: hourly.temperature_2m ? hourly.temperature_2m[i] : null,
        code: hourly.weather_code ? hourly.weather_code[i] : null,
        precipitation: hourly.precipitation_probability ? hourly.precipitation_probability[i] : null,
      })
    }
    return out
  }

  root.FremkitWmo = { GLYPHS: GLYPHS, describe: describe, svg: svg, upcomingHours: upcomingHours }
})(typeof globalThis !== 'undefined' ? globalThis : this)
