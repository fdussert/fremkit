import { countEvents, createCalendarProvider, fetchIcs, IcsFetchError, NotACalendarError } from '../../providers/calendar.js'
import { tr } from '../../i18n.js'
import type { ConnectionType, TestResult } from '../types.js'

export interface IcsTestDeps { fetchFn?: typeof fetch }

/**
 * A calendar published as an ICS file.
 *
 * The URL is the credential: Outlook's "publish" link and Google's "secret address in iCal
 * format" both grant read access to the whole calendar to whoever holds them, so the field is a
 * secret — stored in the secret store, never echoed by the API, never logged, and never quoted in
 * an error message.
 */
export const icsType: ConnectionType = {
  id: 'ics',
  name: { fr: 'Calendrier ICS', en: 'ICS calendar' },
  description: { fr: 'Un calendrier publié au format iCalendar', en: 'A calendar published in iCalendar format' },
  icon: 'calendar-days',
  // Widgets subscribe to a calendar, not to a file format.
  channelPrefix: 'calendar',
  fields: [
    {
      key: 'url',
      label: { fr: 'Adresse du calendrier', en: 'Calendar address' },
      secret: true,
      required: true,
      placeholder: 'https://…/calendar.ics',
      help: {
        fr: 'Le lien ICS publié (Outlook) ou l’« adresse secrète au format iCal » (Google). Il donne accès au calendrier : il est conservé comme un secret.',
        en: 'The published ICS link (Outlook) or the “secret address in iCal format” (Google). It grants access to the calendar, so it is kept as a secret.',
      },
    },
    {
      key: 'color',
      label: { fr: 'Couleur', en: 'Colour' },
      color: true,
      help: {
        fr: 'La pastille qui distingue ce calendrier des autres dans le widget.',
        en: 'The dot that tells this calendar from the others in the widget.',
      },
    },
  ],

  async test(_fields, secrets, deps: IcsTestDeps = {}): Promise<TestResult> {
    const fetchFn = deps.fetchFn ?? fetch
    let ics: string
    try {
      ics = await fetchIcs(secrets.url ?? '', fetchFn)
    } catch (err) {
      if (!(err instanceof IcsFetchError)) return { ok: false, error: tr(undefined, 'ics.unreachable') }
      switch (err.reason) {
        case 'notHttps': return { ok: false, error: tr(undefined, 'ics.notHttps') }
        case 'tooLarge': return { ok: false, error: tr(undefined, 'ics.tooLarge') }
        case 'tooManyRedirects': return { ok: false, error: tr(undefined, 'ics.tooManyRedirects') }
        case 'http': return { ok: false, error: tr(undefined, 'ics.unexpected', { status: err.status }) }
        default: return { ok: false, error: tr(undefined, 'ics.unreachable') }
      }
    }
    try {
      return { ok: true, detail: tr(undefined, 'ics.connected', { events: countEvents(ics) }) }
    } catch (err) {
      if (err instanceof NotACalendarError) return { ok: false, error: tr(undefined, 'ics.notACalendar') }
      return { ok: false, error: tr(undefined, 'ics.notACalendar') }
    }
  },

  createProvider: (ctx) => createCalendarProvider(ctx),
}
