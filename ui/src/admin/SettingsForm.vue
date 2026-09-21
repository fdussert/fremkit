<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import BaseField from '../shared/ui/BaseField.vue'
import BaseInput from '../shared/ui/BaseInput.vue'
import BaseCheckbox from '../shared/ui/BaseCheckbox.vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import { pick, useI18n } from '../shared/i18n'
import { useSocket } from '../shared/socket'
import { useAdminStore } from './store'
import { useConnectionsStore } from './connections'
import { api } from '../shared/api'
import { fieldsInScope, optionLabel, optionValue, suggestApplies, type InstalledAppInfo, type ListItemField, type PickOption, type SettingField, type SettingScope } from '../shared/types'

/**
 * The installed applications, fetched at most once per admin session.
 *
 * Module level rather than per form: the scan behind the route is cached on the server too, but
 * selecting another widget rebuilds the form, and one list serves every one of them.
 */
let installedAppsRequest: Promise<InstalledAppInfo[]> | null = null
function installedAppsOnce(): Promise<InstalledAppInfo[]> {
  // A failure is not retried within the session: the field still accepts anything typed into it.
  installedAppsRequest ??= api.getInstalledApps().catch(() => [])
  return installedAppsRequest
}

const props = defineProps<{
  schema: Record<string, SettingField>
  values: Record<string, unknown>
  /**
   * Which rendering this form configures. A field the manifest scopes to the other one is not
   * rendered; omitting the prop shows the whole schema, as the form always did.
   */
  scope?: SettingScope
  /**
   * The widget this form configures, when the caller knows it.
   *
   * Only used to grant a share: picking a connection that belongs to another widget's declared
   * type has to be recorded on *this* widget's consent, and without the id there is nothing to
   * record it against — so the option is simply not offered.
   */
  widgetId?: string
}>()
const emit = defineEmits<{ change: [key: string, value: unknown] }>()
/** Everything below reads the filtered schema, so a field out of scope is invisible to the form. */
const fields = computed(() => fieldsInScope(props.schema, props.scope))
const val = (k: string): unknown => props.values[k] ?? props.schema[k].default
/** An emptied number field is not a zero: keep the previous value rather than invent one. */
function onNumber(k: string, value: string | number): void {
  if (Number.isFinite(Number(value))) emit('change', k, Number(value))
}

const { t } = useI18n()

/** The one preview in flight, by field key, so the ▶ cannot be hammered while a sound plays. */
const previewing = ref<string | null>(null)
async function preview(k: string, f: SettingField): Promise<void> {
  if (!f.preview) return
  previewing.value = k
  try { await useSocket().command(f.preview.channel, f.preview.command, { value: val(k) }) }
  catch { /* the provider said no, or the socket is down: nothing to show but the silence */ }
  finally { previewing.value = null }
}
const admin = useAdminStore()
const connections = useConnectionsStore()
const hasConnectionField = computed(() => Object.values(fields.value)
  .some((f) => f.type === 'connection' || f.type === 'connections'))
const hasAppsField = computed(() => Object.values(fields.value).some((f) => f.type === 'apps'))

/** Apps the Dock currently reports, for the `apps` setting. */
const dockApps = ref<{ bundleId: string; name: string }[]>([])
/** False while the helper is silent: the list may still hold a stale snapshot. */
const dockAvailable = ref(false)
let unsubscribe: (() => void) | undefined

/**
 * The same `SettingsForm` instance serves every widget — selecting another one changes `schema`
 * rather than remounting — so the wiring follows the schema, not the mount.
 */
watch(hasConnectionField, (has) => {
  if (has && !connections.state.loaded) void connections.load().catch(() => { /* the connections tab shows the error */ })
}, { immediate: true })

watch(hasAppsField, (has) => {
  if (has && !unsubscribe) {
    unsubscribe = useSocket().subscribe('dock', (data) => {
      const snapshot = data as { apps?: { bundleId: string; name: string }[]; available?: boolean } | null
      dockApps.value = (snapshot?.apps ?? []).map((a) => ({ bundleId: a.bundleId, name: a.name }))
      dockAvailable.value = snapshot?.available === true
    })
  } else if (!has && unsubscribe) {
    unsubscribe()
    unsubscribe = undefined
    dockApps.value = []
    dockAvailable.value = false
  }
}, { immediate: true })

onUnmounted(() => unsubscribe?.())

/**
 * The connections of the field's type, plus the currently stored id when it names a connection
 * that no longer exists — otherwise the drop-down would quietly read as "none" while the
 * widget keeps pointing at a dead id.
 */
function connectionOptions(f: SettingField, k: string): { id: string; label: string }[] {
  const list = connections.ofType(f.connectionType ?? '').map((c) => ({ id: c.id, label: c.name }))
  for (const c of reusable(f)) list.push({ id: c.id, label: t('admin.settings.connection.reuse', { name: c.name }) })
  const current = String(val(k) ?? '')
  if (current && !list.some((o) => o.id === current)) list.push({ id: current, label: t('admin.settings.connection.unknown', { id: current }) })
  return list
}

/**
 * Connections of *another* widget's declared type that would fit this one.
 *
 * Two widgets wanting the same Homey should not mean two forms and two copies of one API key.
 * "Fits" is the same kind and the same field keys — which is as close as anything can get to
 * "the same service" without asking the user, and the user is asked all the same: picking one
 * records a share on this widget's consent, and the server refuses any connection not listed
 * there.
 *
 * Never a coded type: sharing may only widen a widget's reach to the kind of thing it could
 * have asked the user to create for it.
 */
function reusable(f: SettingField): { id: string; name: string }[] {
  const mine = connections.state.types.find((t) => t.id === f.connectionType)
  if (!mine?.declaredBy) return []
  const shape = (t: { fields: { key: string; secret?: boolean }[] }): string =>
    t.fields.map((x) => `${x.key}:${x.secret ? 1 : 0}`).sort().join('|')
  const wanted = shape(mine)
  const fits = new Set(connections.state.types
    .filter((t) => t.id !== mine.id && t.declaredBy && shape(t) === wanted)
    .map((t) => t.id))
  return connections.state.connections.filter((c) => fits.has(c.type)).map((c) => ({ id: c.id, name: c.name }))
}

/**
 * Picking a connection, and granting the share when it is somebody else's.
 *
 * The setting is written either way; the share is what makes the proxy accept it, and without
 * it the widget would hold a setting the server answers 409 to.
 */
function chooseConnection(f: SettingField, k: string, id: string): void {
  emit('change', k, id)
  const widgetId = props.widgetId
  if (!id || !widgetId) return
  const chosen = connections.state.connections.find((c) => c.id === id)
  if (!chosen || chosen.type === f.connectionType) return
  void connections.share(widgetId, id, true).catch(() => { /* the connections banner says why */ })
}

/**
 * The key of the type's colour field, when it has one: the admin draws that colour next to each
 * connection so a multi-pick list reads the way the widget will.
 */
function colorKey(typeId: string): string | undefined {
  return connections.state.types.find((t) => t.id === typeId)?.fields.find((f) => f.color && !f.secret)?.key
}

/**
 * The rows of a `connections` setting: every connection of the type, plus any chosen id that no
 * longer exists — dropping it silently would leave the widget pointing at a dead calendar.
 */
function connectionRows(f: SettingField, k: string): { id: string; label: string; color: string; on: boolean }[] {
  const picked = chosen(k)
  const key = colorKey(f.connectionType ?? '')
  const rows = connections.ofType(f.connectionType ?? '').map((c) => ({
    id: c.id,
    label: c.name,
    color: key ? String(c.fields[key] ?? '') : '',
    on: picked.includes(c.id),
  }))
  for (const id of picked) {
    if (!rows.some((r) => r.id === id)) rows.push({ id, label: t('admin.settings.connection.unknown', { id }), color: '', on: true })
  }
  return rows
}

function toggleConnection(k: string, id: string): void {
  const picked = chosen(k)
  emit('change', k, picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id])
}

const chosen = (k: string): string[] => {
  const value = val(k)
  return Array.isArray(value) ? (value as string[]) : []
}

/** Chosen apps first, in the user's order, then everything the Dock offers. */
function appRows(k: string): { bundleId: string; name: string; on: boolean }[] {
  const picked = chosen(k)
  const known = new Map(dockApps.value.map((a) => [a.bundleId, a.name]))
  const rows = picked.map((id) => ({ bundleId: id, name: known.get(id) ?? id, on: true }))
  for (const app of dockApps.value) if (!picked.includes(app.bundleId)) rows.push({ ...app, on: false })
  return rows
}

function toggleApp(k: string, bundleId: string): void {
  const picked = chosen(k)
  emit('change', k, picked.includes(bundleId) ? picked.filter((id) => id !== bundleId) : [...picked, bundleId])
}

function moveApp(k: string, bundleId: string, delta: number): void {
  const picked = [...chosen(k)]
  const at = picked.indexOf(bundleId)
  const to = at + delta
  if (at < 0 || to < 0 || to >= picked.length) return
  picked.splice(to, 0, picked.splice(at, 1)[0])
  emit('change', k, picked)
}

/**
 * A `pick` setting: the choices come from the connection named by its `connection` key, so the
 * list is fetched per field and re-fetched when that connection changes. `token` is the
 * `<connection>|<source>` the options in hand belong to; a late answer to an older token is
 * dropped rather than shown against the wrong connection.
 */
interface PickState { token: string; loading: boolean; error: string; options: PickOption[] }
const picks = reactive<Record<string, PickState>>({})
/** The search box of a pick field, kept out of the config: it filters, it does not configure. */
const searches = reactive<Record<string, string>>({})
/** Above this many choices the list gets a search box; below it, scanning is quicker than typing. */
const SEARCH_FROM = 8

const pickState = (k: string): PickState =>
  picks[k] ?? (picks[k] = { token: '', loading: false, error: '', options: [] })

/** The connection a pick field reads from: the current value of the sibling setting it names. */
function pickConnection(f: SettingField): string {
  const key = f.connection ?? ''
  if (!key || !props.schema[key]) return ''
  return String(props.values[key] ?? props.schema[key].default ?? '')
}

/**
 * One line per pick field, as a string: the watch below fires only when one of them moves.
 *
 * The separators are control characters, which no field key, connection id or source can
 * contain, so two different sets of fields can never build the same signature. They are written
 * as escapes rather than as the characters themselves: embedded raw, they make the file binary
 * as far as `file`, GitHub and `git diff` are concerned.
 */
const pickSignature = computed(() => Object.entries(fields.value)
  .filter(([, f]) => f.type === 'pick')
  .map(([k, f]) => `${k}\0${pickConnection(f)}\0${f.source ?? ''}`)
  .join('\x01'))

async function loadPick(k: string, connection: string, source: string): Promise<void> {
  const token = `${connection}|${source}`
  const state = pickState(k)
  if (state.token === token) return
  state.token = token
  state.options = []
  state.error = ''
  state.loading = false
  if (!connection || !source) return
  state.loading = true
  try {
    const options = await api.getConnectionOptions(connection, source)
    if (pickState(k).token !== token) return
    state.options = options
  } catch (e) {
    if (pickState(k).token !== token) return
    state.error = e instanceof Error ? e.message : String(e)
  } finally {
    if (pickState(k).token === token) state.loading = false
  }
}

watch(pickSignature, () => {
  for (const [k, f] of Object.entries(fields.value)) {
    if (f.type === 'pick') void loadPick(k, pickConnection(f), f.source ?? '')
  }
}, { immediate: true })

/**
 * The ids a pick setting holds. Anything that is not a string is ignored rather than rendered:
 * an instance configured before this setting became a pick still holds its old rows.
 */
const pickedIds = (k: string): string[] => chosen(k).filter((v) => typeof v === 'string')

/** The choices left after the search box, if any: matched on the label, the group and the hint. */
function pickMatches(k: string): PickOption[] {
  const needle = (searches[k] ?? '').trim().toLowerCase()
  const options = pickState(k).options
  if (!needle) return options
  return options.filter((o) => `${o.label} ${o.group ?? ''} ${o.hint ?? ''}`.toLowerCase().includes(needle))
}

/** The matching choices as the list draws them: one section per `group`, ungrouped ones first. */
function pickGroups(k: string): { name: string; options: PickOption[] }[] {
  const groups: { name: string; options: PickOption[] }[] = []
  for (const option of pickMatches(k)) {
    const name = option.group ?? ''
    const hit = groups.find((g) => g.name === name)
    if (hit) hit.options.push(option)
    else groups.push({ name, options: [option] })
  }
  return groups.sort((a, b) => (a.name === '' ? -1 : b.name === '' ? 1 : 0))
}

function togglePick(k: string, value: string): void {
  const picked = pickedIds(k)
  emit('change', k, picked.includes(value) ? picked.filter((v) => v !== value) : [...picked, value])
}

/** Select all / none, over what the search box currently shows rather than the whole house. */
function pickEvery(k: string, on: boolean): void {
  const shown = pickMatches(k).map((o) => o.value)
  const picked = pickedIds(k)
  emit('change', k, on ? [...picked, ...shown.filter((v) => !picked.includes(v))] : picked.filter((v) => !shown.includes(v)))
}

/** Chosen ids the connection no longer offers — a deleted device, or an old name-based value. */
function unknownPicks(k: string): string[] {
  const known = new Set(pickState(k).options.map((o) => o.value))
  return pickedIds(k).filter((v) => !known.has(v))
}

/** Every zone this browser knows, read once: the list is long and it never changes. */
const TIME_ZONES: string[] = (() => {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
  try { return supported ? supported.call(Intl, 'timeZone') : [] } catch { return [] }
})()
/** One <datalist> serves every `timezone` input of the form, so it is rendered once. */
const TIMEZONE_LIST_ID = 'fremkit-timezones'
const isTimezone = (f: { type: string }): boolean => f.type === 'timezone'
const hasTimezoneField = computed(() => Object.values(fields.value)
  .some((f) => isTimezone(f) || Object.values(f.itemSchema ?? {}).some(isTimezone)))
/** One <datalist> serves every `suggest: apps` input of the form, so it is rendered once. */
const APPS_LIST_ID = 'fremkit-installed-apps'
const installedApps = ref<InstalledAppInfo[]>([])
const hasSuggestApps = computed(() => Object.values(fields.value)
  .some((f) => Object.values(f.itemSchema ?? {}).some((itf) => itf.suggest === 'apps')))

watch(hasSuggestApps, (has) => {
  if (has && !installedApps.value.length) void installedAppsOnce().then((apps) => { installedApps.value = apps })
}, { immediate: true })

/**
 * The datalist a list item field gets, or undefined.
 *
 * `suggestWhen` lets a manifest offer the applications only on the rows where they mean something
 * — a shortcut button whose kind is "app" — so a link row keeps a plain text box.
 */
function suggestListId(item: Record<string, unknown>, itf: ListItemField): string | undefined {
  return itf.suggest === 'apps' && suggestApplies(itf, item) ? APPS_LIST_ID : undefined
}

/** An empty zone is merely unfinished; one this browser does not know is wrong and shows red. */
function badTimezone(value: unknown): boolean {
  const zone = String(value ?? '')
  return zone !== '' && TIME_ZONES.length > 0 && !TIME_ZONES.includes(zone)
}

/** The items of a `list` setting; anything else stored under the key reads as an empty list. */
function items(k: string): Record<string, unknown>[] {
  const value = val(k)
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : []
}
const listFull = (f: SettingField, k: string): boolean => f.max !== undefined && items(k).length >= f.max

/** A new item starts from its schema's defaults, and from an empty value where it declares none. */
function newItem(f: SettingField): Record<string, unknown> {
  const item: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(f.itemSchema ?? {})) {
    item[key] = field.default ?? (field.type === 'boolean' ? false : field.type === 'number' ? 0 : '')
  }
  return item
}

// One emit per action, so adding, removing, moving or editing a row is one undo step each.
function addItem(k: string, f: SettingField): void {
  if (!listFull(f, k)) emit('change', k, [...items(k), newItem(f)])
}
function removeItem(k: string, i: number): void {
  emit('change', k, items(k).filter((_, j) => j !== i))
}
function moveItem(k: string, i: number, delta: number): void {
  const list = [...items(k)]
  const to = i + delta
  if (to < 0 || to >= list.length) return
  list.splice(to, 0, list.splice(i, 1)[0])
  emit('change', k, list)
}
function setItemField(k: string, i: number, key: string, value: unknown): void {
  emit('change', k, items(k).map((item, j) => (j === i ? { ...item, [key]: value } : item)))
}
/** An emptied number cell is not a zero: leave the item as it stands, like `onNumber` above. */
function onItemNumber(k: string, i: number, key: string, value: string | number): void {
  if (Number.isFinite(Number(value))) setItemField(k, i, key, Number(value))
}
const itemText = (item: Record<string, unknown>, key: string, field: ListItemField): string =>
  String(item[key] ?? field.default ?? '')
</script>

<template>
  <template v-for="(f, k) in fields" :key="k">
    <BaseCheckbox v-if="f.type === 'boolean'" :model-value="Boolean(val(k))" :label="pick(f.label)"
      @update:model-value="emit('change', k, $event)" />

    <!-- Not a <BaseField>: its <label> must not wrap the "manage connections" button. -->
    <div v-else-if="f.type === 'connection'" class="field">
      <label class="lbl">
        {{ pick(f.label) }}
        <select :value="String(val(k) ?? '')" @change="chooseConnection(f, k, ($event.target as HTMLSelectElement).value)">
          <option value="">{{ t('admin.settings.connection.none') }}</option>
          <option v-for="o in connectionOptions(f, k)" :key="o.id" :value="o.id">{{ o.label }}</option>
        </select>
      </label>
      <small v-if="!connections.ofType(f.connectionType ?? '').length" class="hint">{{ t('admin.settings.connection.empty') }}</small>
      <!-- A widget that declares a connection is useless until one exists, and this form is
           where somebody notices. Sending them to a list of nine types is where that ends. -->
      <button v-if="!connections.ofType(f.connectionType ?? '').length && f.connectionType" type="button"
        class="link" @click="admin.openNewConnection(f.connectionType)">
        {{ t('admin.settings.connection.create') }}
      </button>
      <button type="button" class="link" @click="admin.openModal('connections')">{{ t('admin.settings.connection.manage') }}</button>
    </div>

    <!-- Not a <BaseField>: its <label> must not wrap the per-connection checkbox labels. -->
    <div v-else-if="f.type === 'connections'" class="field">
      <span class="lbl">{{ pick(f.label) }}</span>
      <p v-if="!connectionRows(f, k).length" class="hint">{{ t('admin.settings.connection.empty') }}</p>
      <ul v-else class="picks">
        <li v-for="row in connectionRows(f, k)" :key="row.id">
          <i v-if="row.color" class="swatch" :style="{ background: row.color }" />
          <BaseCheckbox :model-value="row.on" :label="row.label" @update:model-value="toggleConnection(k, row.id)" />
        </li>
      </ul>
      <button type="button" class="link" @click="admin.openModal('connections')">{{ t('admin.settings.connection.manage') }}</button>
    </div>

    <!-- Not a <BaseField>: its <label> must not wrap the per-choice checkbox labels. -->
    <div v-else-if="f.type === 'pick'" class="field">
      <span class="lbl">{{ pick(f.label) }}</span>
      <p v-if="!pickConnection(f)" class="hint">{{ t('admin.settings.pick.chooseConnection') }}</p>
      <p v-else-if="pickState(k).loading" class="hint">{{ t('common.loading') }}</p>
      <p v-else-if="pickState(k).error" class="hint bad">{{ pickState(k).error }}</p>
      <p v-else-if="!pickState(k).options.length" class="hint">{{ t('admin.settings.pick.empty') }}</p>
      <template v-else>
        <BaseInput v-if="pickState(k).options.length > SEARCH_FROM" :placeholder="t('admin.settings.pick.search')"
          :model-value="searches[k] ?? ''" @update:model-value="searches[k] = String($event)" />
        <div class="bulk">
          <button type="button" class="link" @click="pickEvery(k, true)">{{ t('admin.settings.pick.all') }}</button>
          <button type="button" class="link" @click="pickEvery(k, false)">{{ t('admin.settings.pick.none') }}</button>
        </div>
        <ul class="picks">
          <template v-for="group in pickGroups(k)" :key="group.name">
            <li v-if="group.name" class="group">{{ group.name }}</li>
            <li v-for="o in group.options" :key="o.value">
              <BaseCheckbox :model-value="pickedIds(k).includes(o.value)" :label="o.label"
                @update:model-value="togglePick(k, o.value)" />
              <small v-if="o.hint" class="tag">{{ o.hint }}</small>
            </li>
          </template>
        </ul>
        <p v-if="!pickMatches(k).length" class="hint">{{ t('admin.settings.pick.noMatch') }}</p>
        <p v-if="unknownPicks(k).length" class="hint">{{ t('admin.settings.pick.unknown', { count: unknownPicks(k).length }) }}</p>
      </template>
    </div>

    <!-- Not a <BaseField> either: its <label> must not wrap the per-app checkbox labels. -->
    <div v-else-if="f.type === 'apps'" class="field">
      <span class="lbl">{{ pick(f.label) }}</span>
      <p v-if="!dockAvailable || !dockApps.length" class="hint">{{ t('admin.settings.apps.helper') }}</p>
      <ul v-if="dockApps.length" class="apps">
        <li v-for="(row, i) in appRows(k)" :key="row.bundleId">
          <BaseCheckbox :model-value="row.on" :label="row.name" @update:model-value="toggleApp(k, row.bundleId)" />
          <BaseButton v-if="row.on" variant="icon" :title="t('common.moveUp')" :disabled="i === 0" @click="moveApp(k, row.bundleId, -1)">
            <BaseIcon name="chevron-up" :size="14" />
          </BaseButton>
          <BaseButton v-if="row.on" variant="icon" :title="t('common.moveDown')" :disabled="i === chosen(k).length - 1"
            @click="moveApp(k, row.bundleId, 1)">
            <BaseIcon name="chevron-down" :size="14" />
          </BaseButton>
        </li>
      </ul>
    </div>

    <!-- Not a <BaseField>: its <label> must not wrap the per-item fields and buttons. -->
    <div v-else-if="f.type === 'list'" class="field">
      <span class="lbl">{{ pick(f.label) }}</span>
      <p v-if="!items(k).length" class="hint">{{ t('admin.settings.list.empty') }}</p>
      <ul v-else class="list">
        <li v-for="(item, i) in items(k)" :key="i">
          <div class="cells">
            <label v-for="(itf, ik) in f.itemSchema" :key="ik" class="cell" :class="{ flag: itf.type === 'boolean' }">
              <span class="cap">{{ pick(itf.label) }}</span>
              <input v-if="itf.type === 'boolean'" type="checkbox" :checked="Boolean(item[ik])"
                @change="setItemField(k, i, ik, ($event.target as HTMLInputElement).checked)" />
              <select v-else-if="itf.type === 'enum'" :value="itemText(item, ik, itf)"
                @change="setItemField(k, i, ik, ($event.target as HTMLSelectElement).value)">
                <option v-for="o in itf.options" :key="optionValue(o)" :value="optionValue(o)">{{ pick(optionLabel(o)) }}</option>
              </select>
              <BaseInput v-else-if="itf.type === 'number'" type="number" lazy :model-value="Number(item[ik] ?? 0)"
                @update:model-value="onItemNumber(k, i, ik, $event)" />
              <BaseInput v-else-if="itf.type === 'timezone'" lazy :list="TIMEZONE_LIST_ID"
                :invalid="badTimezone(item[ik])" :title="badTimezone(item[ik]) ? t('admin.settings.timezone.unknown') : undefined"
                :model-value="itemText(item, ik, itf)" @update:model-value="setItemField(k, i, ik, String($event).trim())" />
              <BaseInput v-else lazy :list="suggestListId(item, itf)" :model-value="itemText(item, ik, itf)"
                @update:model-value="setItemField(k, i, ik, $event)" />
            </label>
          </div>
          <div class="rowActions">
            <BaseButton variant="icon" :title="t('common.moveUp')" :disabled="i === 0" @click="moveItem(k, i, -1)">
              <BaseIcon name="chevron-up" :size="14" />
            </BaseButton>
            <BaseButton variant="icon" :title="t('common.moveDown')" :disabled="i === items(k).length - 1" @click="moveItem(k, i, 1)">
              <BaseIcon name="chevron-down" :size="14" />
            </BaseButton>
            <BaseButton variant="icon" :title="t('common.remove')" @click="removeItem(k, i)">
              <BaseIcon name="trash-2" :size="14" />
            </BaseButton>
          </div>
        </li>
      </ul>
      <BaseButton class="add" :disabled="listFull(f, k)" @click="addItem(k, f)">
        <BaseIcon name="plus" :size="14" />{{ t('admin.settings.list.add') }}
      </BaseButton>
    </div>

    <BaseField v-else :label="pick(f.label)">
      <BaseInput v-if="f.type === 'number'" type="number" lazy :model-value="Number(val(k) ?? 0)"
        @update:model-value="onNumber(k, $event)" />
      <input v-else-if="f.type === 'color'" class="color" type="color" :value="String(val(k) ?? '#000000')"
        @change="emit('change', k, ($event.target as HTMLInputElement).value)" />
      <div v-else-if="f.type === 'enum'" class="enumRow">
        <select :value="String(val(k) ?? '')"
          @change="emit('change', k, ($event.target as HTMLSelectElement).value)">
          <option v-for="o in f.options" :key="optionValue(o)" :value="optionValue(o)">{{ pick(optionLabel(o)) }}</option>
        </select>
        <!-- A preview sends the chosen value to the provider, which decides what showing it means. -->
        <BaseButton v-if="f.preview" variant="icon" :title="t('admin.settings.preview')" :disabled="previewing === k"
          @click="preview(k, f)">
          <BaseIcon name="play" :size="16" />
        </BaseButton>
      </div>
      <BaseInput v-else-if="f.type === 'timezone'" lazy :list="TIMEZONE_LIST_ID" :invalid="badTimezone(val(k))"
        :title="badTimezone(val(k)) ? t('admin.settings.timezone.unknown') : undefined"
        :model-value="String(val(k) ?? '')" @update:model-value="emit('change', k, String($event).trim())" />
      <BaseInput v-else lazy :model-value="String(val(k) ?? '')" @update:model-value="emit('change', k, $event)" />
    </BaseField>
  </template>

  <!-- Shared by every timezone input above: the browser turns it into a searchable drop-down. -->
  <datalist v-if="hasTimezoneField" :id="TIMEZONE_LIST_ID">
    <option v-for="zone in TIME_ZONES" :key="zone" :value="zone" />
  </datalist>

  <!-- Shared by every `suggest: apps` input above. The name is what `open -a` takes, so it is
       both what is shown and what is stored; typing something else stays perfectly valid. -->
  <datalist v-if="hasSuggestApps" :id="APPS_LIST_ID">
    <option v-for="app in installedApps" :key="app.bundleId" :value="app.name" />
  </datalist>
</template>

<style scoped>
select, .color { width: 100%; box-sizing: border-box; font: inherit; font-size: var(--fs-sm); color: var(--text);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 6px 8px; }
.color { padding: 2px; height: 32px; }
/* Mirrors BaseField, which cannot be used where the slot holds interactive labels of its own. */
.field { display: flex; flex-direction: column; gap: var(--space-1); margin-bottom: var(--space-3); }
.enumRow { display: flex; align-items: center; gap: var(--space-2); }
.enumRow > select { flex: 1; min-width: 0; }
.lbl { display: flex; flex-direction: column; gap: var(--space-1);
  font-size: var(--fs-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: .06em; }
.lbl select { text-transform: none; letter-spacing: normal; }
.hint { font-size: var(--fs-xs); color: var(--text-dim); margin: var(--space-1) 0 0; }
.link { align-self: flex-start; font: inherit; font-size: var(--fs-xs); cursor: pointer;
  border: 0; background: none; padding: 0; color: var(--accent); text-decoration: underline; }
.picks { list-style: none; margin: 0; padding: 0; max-height: 220px; overflow-y: auto; }
/* The row owns its spacing, not the checkbox: a `.cb` that kept its bottom margin would centre
   the swatch on box-plus-margin and leave the leading dot sitting above the label. */
.picks li { display: flex; align-items: center; gap: var(--space-2); padding: 2px 0; }
/* A group heading inside the same list: the zone, the flow folder. */
.picks li.group { font-size: var(--fs-xs); color: var(--text-dim); text-transform: uppercase; letter-spacing: .06em;
  margin-top: var(--space-1); }
.picks li.group:first-child { margin-top: 0; }
.tag { flex: 0 0 auto; font-size: var(--fs-xs); color: var(--text-dim); }
.bulk { display: flex; gap: var(--space-2); }
.hint.bad { color: var(--danger); }
.picks li :deep(.cb) { flex: 1; margin-bottom: 0; padding: 0; min-width: 0; }
.swatch { flex: 0 0 auto; width: 10px; height: 10px; border-radius: 5px; border: 1px solid var(--border-strong); }
.apps { list-style: none; margin: 0; padding: 0; max-height: 220px; overflow-y: auto; }
.apps li { display: flex; align-items: center; gap: var(--space-1); }
.apps li :deep(.cb) { flex: 1; margin-bottom: 0; padding: 2px 0; min-width: 0; }
/* One item per row: its fields wrap inline on the left, the three buttons stay on the right. */
.list { list-style: none; margin: 0 0 var(--space-1); padding: 0; display: flex; flex-direction: column; gap: var(--space-1); }
.list li { display: flex; align-items: flex-end; gap: var(--space-1);
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--space-2); }
.cells { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-2); }
.cell { flex: 1 1 110px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
/* A checkbox needs no column of its own: label beside the box, sized to its content. */
.cell.flag { flex: 0 0 auto; flex-direction: row-reverse; align-items: center; gap: var(--space-1); }
.cell.flag input { accent-color: var(--accent); width: 16px; height: 16px; }
.cap { font-size: var(--fs-xs); color: var(--text-dim); text-transform: uppercase; letter-spacing: .06em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rowActions { display: flex; flex: 0 0 auto; }
.add { align-self: flex-start; }
</style>
