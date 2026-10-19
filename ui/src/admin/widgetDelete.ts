import { useConfirm } from '../shared/useConfirm'

/**
 * The one two-tap confirmation for deleting a widget outright — removing it from the last screen
 * that shows it. The inspector's button, the bar editor's and the Delete key share it, so a
 * press of Delete arms the button the user can see, and either one confirms.
 */
export const widgetDelete = useConfirm()
export const widgetDeleteKey = (instanceId: string): string => `widget:${instanceId}`
/** The confirmation of a group whose removal deletes at least one widget: the same tiles, in any order. */
export const tilesDeleteKey = (instanceIds: string[]): string => `widgets:${[...instanceIds].sort().join(',')}`
