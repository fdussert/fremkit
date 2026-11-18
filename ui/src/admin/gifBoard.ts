/**
 * The GIF board's collection, edited: pure helpers the editor panel calls inside the admin
 * store's `apply()`, so every edit is undoable and saved. Each mutates the board it is given.
 *
 * The limits mirror `GifBoardSchema` (`server/src/config/schema.ts`): an edit that would break
 * one does nothing, rather than leave a config the server refuses to save.
 */
import type { GifBoard, GifGroup, GifItem } from '../shared/types'

export const MAX_GROUPS = 30
export const MAX_ITEMS = 200
export const MAX_NAME = 40
export const MAX_LABEL = 40

/** Mirror `giphyThumbUrl` in `server/src/gifs/store.ts`: what the editor draws a Giphy GIF with. */
export const giphyThumbUrl = (giphyId: string): string => `https://media.giphy.com/media/${giphyId}/200w.gif`
/** A link's copy in this Mac's cache; the server never fetches for this route. */
export const linkThumbUrl = (url: string): string => `/api/gifs/cached?url=${encodeURIComponent(url)}`

export function thumbOf(item: GifItem): string {
  return item.kind === 'giphy' ? giphyThumbUrl(item.giphyId) : linkThumbUrl(item.url)
}

/** An item before it has an id; distributes over the kinds, which `Omit<GifItem, 'id'>` would merge. */
export type NewGifItem = GifItem extends infer T ? (T extends GifItem ? Omit<T, 'id'> : never) : never

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** 10 characters of [a-z0-9], as the schema's ids want. */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}

const groupOf = (b: GifBoard, groupId: string): GifGroup | undefined => b.groups.find((g) => g.id === groupId)

function locate(b: GifBoard, itemId: string): { group: GifGroup; index: number } | undefined {
  for (const group of b.groups) {
    const index = group.items.findIndex((x) => x.id === itemId)
    if (index >= 0) return { group, index }
  }
  return undefined
}

/** The new group's id, or '' when the board already holds as many as it may. */
export function addGroup(b: GifBoard, name: string): string {
  const clean = name.trim().slice(0, MAX_NAME)
  if (!clean || b.groups.length >= MAX_GROUPS) return ''
  const id = newId()
  b.groups.push({ id, name: clean, items: [] })
  return id
}

/** An empty name keeps the old one. */
export function renameGroup(b: GifBoard, groupId: string, name: string): void {
  const clean = name.trim().slice(0, MAX_NAME)
  const group = groupOf(b, groupId)
  if (group && clean) group.name = clean
}

/** Moves a group to `toIndex` — its index once moved, clamped to the end. */
export function moveGroup(b: GifBoard, groupId: string, toIndex: number): void {
  const from = b.groups.findIndex((g) => g.id === groupId)
  if (from < 0) return
  const [group] = b.groups.splice(from, 1)
  b.groups.splice(Math.max(0, Math.min(toIndex, b.groups.length)), 0, group)
}

export function removeGroup(b: GifBoard, groupId: string): void {
  b.groups = b.groups.filter((g) => g.id !== groupId)
}

/** The new item's id, or '' when the group is gone or full. */
export function addItem(b: GifBoard, groupId: string, item: NewGifItem): string {
  const group = groupOf(b, groupId)
  if (!group || group.items.length >= MAX_ITEMS) return ''
  const id = newId()
  group.items.push({ ...item, id } as GifItem)
  return id
}

export function removeItem(b: GifBoard, itemId: string): void {
  const at = locate(b, itemId)
  if (at) at.group.items.splice(at.index, 1)
}

/**
 * Moves an item to `toIndex` of `toGroupId` — its index once moved, clamped to the end. Nothing
 * moves into another group that is full.
 */
export function moveItem(b: GifBoard, itemId: string, toGroupId: string, toIndex: number): void {
  const at = locate(b, itemId)
  const target = groupOf(b, toGroupId)
  if (!at || !target) return
  if (target !== at.group && target.items.length >= MAX_ITEMS) return
  const [item] = at.group.items.splice(at.index, 1)
  target.items.splice(Math.max(0, Math.min(toIndex, target.items.length)), 0, item)
}

/** '' (or blanks) removes the label. */
export function setLabel(b: GifBoard, itemId: string, label: string): void {
  const at = locate(b, itemId)
  if (!at) return
  const item = at.group.items[at.index]
  const clean = label.trim().slice(0, MAX_LABEL)
  if (clean) item.label = clean
  else delete item.label
}

export function findGiphy(b: GifBoard, groupId: string, giphyId: string): GifItem | undefined {
  return groupOf(b, groupId)?.items.find((x) => x.kind === 'giphy' && x.giphyId === giphyId)
}

export function findLink(b: GifBoard, groupId: string, url: string): GifItem | undefined {
  return groupOf(b, groupId)?.items.find((x) => x.kind === 'link' && x.url === url)
}
