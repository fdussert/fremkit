/** Every source the provider knows, in the order the settings list them. */
export const SOURCE_IDS = ['git', 'claude', 'codex', 'vscode', 'cursor', 'jetbrains', 'zoxide', 'tmux', 'herdr'] as const
export type SourceId = (typeof SOURCE_IDS)[number]

/** One folder a source says was used, before it is canonicalised. */
export interface SourceEntry {
  path: string
  /** Epoch milliseconds, or null when the source keeps an order but no date (zoxide). */
  seenAt: number | null
  /** The git source only: the root, as typed, the repository was found under. */
  gitRoot?: string
}

/** What a source is handed on each poll: the settings every shown instance asked for, merged. */
export interface SourceContext {
  home: string
  /** Git roots as typed in the settings (`~/Dev`, `/Volumes/Dev`), one list for every instance. */
  gitRoots: string[]
}

/**
 * A place recent folders can be read from. `available` answers whether the program or file it
 * reads is on this Mac at all, so a missing one is shown as such rather than as an error; `list`
 * reads it, cheaply, and throws when it could not.
 */
export interface Source {
  id: SourceId
  label: { fr: string; en: string }
  /**
   * The source reports what is open now (terminal panes), not a history: the provider remembers
   * what it saw, in memory, so a folder stays listed after its pane is closed.
   */
  live?: boolean
  available(ctx: SourceContext): Promise<boolean>
  list(ctx: SourceContext): Promise<SourceEntry[]>
}

/** One project as the channel publishes it. */
export interface RecentProject {
  path: string
  name: string
  /** The parent folder, `~/` for the home folder. */
  parent: string
  seenAt: number | null
  sources: SourceId[]
  /** For a repository the git source found: the roots (as typed) it sits under. */
  gitRoots?: string[]
}

export interface SourceStatus {
  id: SourceId
  /** Asked for by at least one shown instance. Sources nobody asked for are never read. */
  enabled: boolean
  available: boolean
  count: number
  error?: string
}
