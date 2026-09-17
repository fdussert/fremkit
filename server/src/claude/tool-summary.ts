const MAX = 80

/** Short, safe description of a tool call for display. Never returns the full input. */
export function summarizeTool(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const i = input as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  let s: string | undefined
  switch (name) {
    case 'Bash': s = str(i.description) ?? str(i.command); break
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': s = str(i.file_path); break
    case 'Grep': case 'Glob': s = str(i.pattern); break
    case 'Agent': case 'Task': s = str(i.description); break
    case 'WebFetch': case 'WebSearch': s = str(i.url) ?? str(i.query); break
    default: s = str(i.description)
  }
  if (!s) return undefined
  return s.length > MAX ? s.slice(0, MAX) : s
}
