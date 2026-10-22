/**
 * The home folder written `~` wherever it appears as a path: followed by `/`, a word boundary
 * (`:`, `,`, a quote, a parenthesis, a space…) or the end. Shared by the diagnostics' `redact()`
 * and Fremdev's server list, so both hide the account name the same way.
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function homeToTilde(text: string, home: string | undefined | null): string {
  if (!home || home.length <= 1) return text
  const h = home.replace(/\/+$/, '')
  if (h.length <= 1) return text
  return text.replace(new RegExp(`${escapeRegExp(h)}(?=/|\\b|$)`, 'g'), '~')
}
