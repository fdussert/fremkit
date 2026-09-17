import { describe, it, expect } from 'vitest'
import { parsePs, parseLsof, listClaudeProcesses } from '../src/claude/processes.js'

const PS = `  1769 Fri 11 Sep 09:07:50 2026     /Users/alice/.local/bin/claude --chrome-native-host
46407 Wed 16 Sep 15:02:11 2026     claude
43323 Wed 16 Sep 14:10:03 2026     /Users/alice/.local/bin/claude --resume abc
  999 Wed 16 Sep 14:10:03 2026     node /some/claude-code-helper.js
  777 Wed 16 Sep 14:10:03 2026     grep claude
`
const LSOF = `p46407
n/Users/alice
p43323
n/Users/alice/projects/webapp
`
describe('parsePs', () => {
  it('keeps claude CLI processes only and parses lstart', () => {
    const r = parsePs(PS)
    expect(r.map((p) => p.pid)).toEqual([46407, 43323])
    expect(new Date(r[0].startedAt).getFullYear()).toBe(2026)
  })
})
describe('parseLsof', () => {
  it('maps pid to cwd', () => { expect([...parseLsof(LSOF)]).toEqual([[46407, '/Users/alice'], [43323, '/Users/alice/projects/webapp']]) })
})
describe('listClaudeProcesses', () => {
  it('combines ps and lsof, returns null on failure', async () => {
    const run = async (cmd: string) => (cmd === 'ps' ? PS : LSOF)
    expect(await listClaudeProcesses(run)).toEqual([
      { pid: 46407, cwd: '/Users/alice', startedAt: expect.any(Number) },
      { pid: 43323, cwd: '/Users/alice/projects/webapp', startedAt: expect.any(Number) },
    ])
    expect(await listClaudeProcesses(async () => { throw new Error('nope') })).toBeNull()
    expect(await listClaudeProcesses(async (cmd: string) => (cmd === 'ps' ? '' : ''))).toEqual([])
  })
})
