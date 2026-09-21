/**
 * @vitest-environment jsdom
 *
 * What a version says it changed, wherever the admin shows it.
 *
 * The registry now carries each release's changelog entry into the index, and the person in
 * front of *Update all* finally has an answer to the question they were actually asking. Three
 * things have to hold: the entry is rendered as **text** (it was written by whoever opened a
 * pull request on the registry, and it arrives over the network), a dialog says so rather than
 * drawing nothing when there is no entry, and an update several versions behind lists every
 * version it is taking — not only the newest.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ChangeNotes from '../src/admin/ChangeNotes.vue'
import ConsentDialog from '../src/admin/ConsentDialog.vue'
import MarketplaceRow from '../src/admin/MarketplaceRow.vue'
import UpdateAllDialog from '../src/admin/UpdateAllDialog.vue'
import type { MarketplaceWidget, WidgetPermissionSet } from '../src/shared/types'

const NONE: WidgetPermissionSet = { subscriptions: [], commands: [], network: [] }

function widget(over: Partial<MarketplaceWidget> = {}): MarketplaceWidget {
  return {
    id: 'key-light', version: '1.2.0', sdk: 1, category: 'desk',
    name: { fr: 'Key Light', en: 'Key Light' }, description: { fr: 'd', en: 'd' },
    icon: 'sun', permissions: NONE, connections: [], size: 4096,
    publishedAt: '2026-09-21T08:00:00.000Z',
    installed: false, installedVersion: null, updateAvailable: false,
    sdkTooNew: false, consentNeeded: true, newPermissions: NONE,
    shadowsBuiltin: false, history: [], placedOn: [],
    ...over,
  }
}

describe('the entry itself', () => {
  it('renders the text as text, whatever it contains', () => {
    // The registry strips markdown at its end. This end does not rely on that having worked:
    // a `<script>` in an entry is characters on a card, never a node in the document.
    const w = mount(ChangeNotes, { props: { changes: '<b>bold</b> & <script>x</script>' } })
    expect(w.text()).toContain('<b>bold</b> & <script>x</script>')
    expect(w.find('b').exists()).toBe(false)
    expect(w.find('script').exists()).toBe(false)
  })

  it('keeps the author’s newlines', () => {
    const w = mount(ChangeNotes, { props: { changes: 'Added\nFixed' } })
    expect(w.find('.text').text()).toBe('Added\nFixed')
  })

  it('draws nothing at all when there is no entry and none is asked for', () => {
    // A card is a card: an empty line under every widget that predates the changelog would be
    // noise. A dialog asks for the opposite — see below.
    expect(mount(ChangeNotes, { props: {} }).text()).toBe('')
  })

  it('says there are no notes when asked to', () => {
    const w = mount(ChangeNotes, { props: { sayWhenEmpty: true } })
    expect(w.find('.no-notes').exists()).toBe(true)
  })

  it('hides the earlier versions until they are asked for', async () => {
    const w = mount(ChangeNotes, {
      props: {
        changes: 'Newest',
        history: [{ version: '1.2.0', changes: 'Newest' }, { version: '1.1.0', changes: 'Older' }],
      },
    })
    expect(w.text()).not.toContain('Older')
    await w.find('.more').trigger('click')
    expect(w.text()).toContain('Older')
    expect(w.text()).toContain('1.1.0')
  })

  it('offers no button when the latest entry is all there is and it is short', () => {
    const w = mount(ChangeNotes, { props: { changes: 'Short.', history: [{ version: '1.2.0', changes: 'Short.' }] } })
    expect(w.find('.more').exists()).toBe(false)
  })
})

describe('the card', () => {
  const row = (w: MarketplaceWidget) => mount(MarketplaceRow, { props: { widget: w } })

  it('shows the latest entry under the chip', () => {
    expect(row(widget({ changes: 'Reads the brightness at startup.' })).text())
      .toContain('Reads the brightness at startup.')
  })

  it('shows nothing for a widget whose registry never carried an entry', () => {
    expect(row(widget()).find('.notes').exists()).toBe(false)
  })

  it('offers every version an update would bring, down to the one installed', async () => {
    const w = row(widget({
      installed: true, installedVersion: '1.0.0', updateAvailable: true,
      changes: 'Newest.',
      history: [
        { version: '1.2.0', changes: 'Newest.' },
        { version: '1.1.0', changes: 'Middle.' },
        { version: '1.0.0', changes: 'The one already installed.' },
      ],
    }))
    await w.find('.more').trigger('click')
    expect(w.text()).toContain('Middle.')
    // The installed version's own entry is history, not a decision: it is not in the list.
    expect(w.text()).not.toContain('The one already installed.')
  })
})

describe('the dialogs', () => {
  const prompt = (w: MarketplaceWidget) => ({
    widget: w, update: false, added: NONE, all: NONE, send: NONE,
  })

  it('the consent dialog puts the entry beside the permissions', () => {
    const w = mount(ConsentDialog, {
      props: { prompt: prompt(widget({ changes: 'Stops asking for the network.' })) as never },
    })
    expect(w.text()).toContain('Stops asking for the network.')
  })

  it('the consent dialog says a version documented nothing rather than leaving a gap', () => {
    const w = mount(ConsentDialog, { props: { prompt: prompt(widget()) as never } })
    expect(w.find('.no-notes').exists()).toBe(true)
    expect(w.text()).toContain('Aucune note pour cette version.')
  })

  it('Update all names what each widget changed', () => {
    const w = mount(UpdateAllDialog, {
      props: {
        entries: [
          { widget: widget({ id: 'a', changes: 'One thing.' }), added: NONE },
          { widget: widget({ id: 'b' }), added: NONE },
        ],
      },
    })
    expect(w.text()).toContain('One thing.')
    // The widget with no entry still says so: a silent row would read as "nothing changed".
    expect(w.text()).toContain('Aucune note pour cette version.')
  })
})
