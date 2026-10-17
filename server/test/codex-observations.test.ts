import { afterEach, describe, expect, it } from 'vite-plus/test'
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  createCodexSessionsProvider,
  createSessionReader,
  freshTurn,
  parseTurnRecords,
} from '../src/codex/observations.js'
import type { History } from '../src/codex/snapshot.js'

const A = '00000000-0000-4000-8000-000000000001'
const B = '00000000-0000-4000-8000-000000000002'
const C = '00000000-0000-4000-8000-000000000003'
const now = 1800000000000
const line = (type: string, payload: unknown, at = now) =>
  JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload }) + '\n'
const started = line(
  'event_msg',
  {
    type: 'task_started',
    turn_id: 'turn-a',
    started_at: (now - 120000) / 1000,
  },
  now - 120000,
)
const context = line(
  'turn_context',
  {
    turn_id: 'turn-a',
    model: 'gpt-example',
    effort: 'high',
    cwd: '/private/project',
    instructions: 'PRIVATE PROMPT',
  },
  now - 119000,
)
const progress = line(
  'response_item',
  {
    type: 'function_call',
    name: 'exec_command',
    arguments: 'PRIVATE TOKEN',
  },
  now,
)

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

describe('Codex turn observations', () => {
  it('tracks explicit start and per-turn model without exposing prompt/tool content', () => {
    const turn = parseTurnRecords(started + context + progress)
    expect(turn).toMatchObject({
      state: 'working',
      startedAt: now - 120000,
      model: 'gpt-example',
      effort: 'high',
      lastEventAt: now,
    })
    expect(JSON.stringify(turn)).not.toMatch(/PRIVATE|instructions|arguments|cwd/)
  })

  it('uses observed completion duration and does not confuse another turn completion', () => {
    const turn = parseTurnRecords(
      started +
        context +
        line('event_msg', {
          type: 'task_complete',
          turn_id: 'other',
        }),
    )
    expect(turn.state).toBe('working')
    const done = parseTurnRecords(
      line('event_msg', {
        type: 'task_complete',
        turn_id: 'turn-a',
        duration_ms: 120000,
        completed_at: now / 1000,
      }),
      turn,
    )
    expect(done).toMatchObject({ state: 'done', durationMs: 120000, finishedAt: now })
  })

  it('marks silent unfinished turns unknown instead of reporting them active indefinitely', () => {
    const turn = parseTurnRecords(started + context + progress)
    expect(freshTurn(turn, now + 90001).state).toBe('unknown')
    expect(freshTurn(turn, now).state).toBe('working')
    expect(freshTurn(turn, now - 1).state).toBe('unknown')
  })

  it('recognizes user input waits, resumption, and interruption', () => {
    let turn = parseTurnRecords(
      started +
        line('response_item', {
          type: 'function_call',
          name: 'functions.request_user_input_async',
        }),
    )
    expect(turn.state).toBe('waiting')
    turn = parseTurnRecords(line('response_item', { type: 'reasoning', text: 'PRIVATE' }), turn)
    expect(turn.state).toBe('working')
    expect(
      parseTurnRecords(
        line('event_msg', {
          type: 'turn_aborted',
          turn_id: 'turn-a',
        }),
        turn,
      ).state,
    ).toBe('interrupted')
  })

  it('does not infer work or a start from a model/context or generic history update alone', () => {
    expect(parseTurnRecords(context + progress)).toMatchObject({
      state: 'unknown',
      startedAt: null,
      model: 'gpt-example',
    })
    expect(parseTurnRecords('broken\n')).toMatchObject({ state: 'unknown' })
  })
})

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'codex-observation-'))
  dirs.push(home)
  await mkdir(join(home, 'sessions'))
  const parent = join(home, 'sessions', 'parent.jsonl')
  const child = join(home, 'sessions', 'child.jsonl')
  await writeFile(parent, line('session_meta', { id: A }) + started + context + progress)
  await writeFile(
    child,
    line('session_meta', { id: B }) +
      started +
      context +
      line('event_msg', {
        type: 'task_complete',
        turn_id: 'turn-a',
        duration_ms: 120000,
      }),
  )
  const database = join(home, 'state_5.sqlite')
  execFileSync('/usr/bin/sqlite3', [
    database,
    `
    CREATE TABLE threads (id TEXT, rollout_path TEXT, model TEXT, reasoning_effort TEXT,
      cwd TEXT, git_branch TEXT, agent_nickname TEXT, agent_role TEXT, agent_path TEXT,
      archived INTEGER, updated_at INTEGER);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
    INSERT INTO threads VALUES
      ('${A}','${parent}','stored-model','low','/private/example-project','main',NULL,NULL,NULL,0,1),
      ('${B}','${child}','stored-child','low','/private/example-project','main','Agent Example','worker','/root/check',0,1),
      ('${C}',NULL,'unrelated','low','/private/other',NULL,NULL,NULL,NULL,0,1);
    INSERT INTO thread_spawn_edges VALUES ('${A}','${B}');
  `,
  ])
  return { home, parent, child, database }
}

describe('Selected Codex local session reader', () => {
  it('joins selected parent and direct child, sanitizes project paths and keeps unrelated threads private', async () => {
    const f = await fixture()
    const snapshot = await createSessionReader({ codexHome: f.home })([A], now)
    expect(snapshot.sessions).toHaveLength(1)
    expect(snapshot.sessions[0]).toMatchObject({
      id: A,
      project: 'example-project',
      branch: 'main',
      model: 'gpt-example',
      modelSource: 'turn',
      state: 'working',
      subagents: [
        {
          id: B,
          nickname: 'Agent Example',
          role: 'worker',
          agentName: 'check',
          state: 'done',
        },
      ],
    })
    expect(JSON.stringify(snapshot)).not.toMatch(/rollout|\/private\/|unrelated|PRIVATE/)
    expect(snapshot.truncated).toBe(false)
  })

  it('preserves a start through incremental updates and split UTF-8 JSON records', async () => {
    const f = await fixture()
    const read = createSessionReader({ codexHome: f.home })
    await read([A], now)
    const next = line('response_item', { type: 'reasoning', text: 'privé' }, now + 1000)
    const bytes = Buffer.from(next)
    const split = bytes.indexOf(Buffer.from('é')) + 1
    await appendFile(f.parent, bytes.subarray(0, split))
    await read([A], now + 1000)
    await appendFile(f.parent, bytes.subarray(split))
    const snapshot = await read([A], now + 1000)
    expect(snapshot.sessions[0]).toMatchObject({
      state: 'working',
      startedAt: now - 120000,
      lastEventAt: now + 1000,
    })
  })

  it('recovers after an oversized record arrives in chunks before a completion event', async () => {
    const f = await fixture()
    const read = createSessionReader({ codexHome: f.home })
    await read([A], now)
    const large = line('response_item', { type: 'message', content: 'x'.repeat(600000) })
    await appendFile(f.parent, large.slice(0, 400000))
    expect((await read([A], now)).sessions[0].state).toBe('working')
    await appendFile(f.parent, large.slice(400000) + line('event_msg', {
      type: 'task_complete', turn_id: 'turn-a', completed_at: now / 1000,
    }))
    const finished = await read([A], now)
    expect(finished.sessions[0]).toMatchObject({ state: 'done', finishedAt: now })
  })

  it('retains a turn start beyond a large recent output on initial observation', async () => {
    const f = await fixture()
    await appendFile(
      f.parent,
      line('response_item', {
        type: 'message',
        content: 'x'.repeat(3000000),
      }) + progress,
    )
    const snapshot = await createSessionReader({ codexHome: f.home })([A], now)
    expect(snapshot.sessions[0]).toMatchObject({ state: 'working', startedAt: now - 120000 })
  })

  it('refuses a rollout belonging to another ID and a path outside sessions', async () => {
    const f = await fixture()
    await writeFile(f.parent, line('session_meta', { id: C }) + started + progress)
    let snapshot = await createSessionReader({ codexHome: f.home })([A], now)
    expect(snapshot.sessions[0].state).toBe('unknown')
    const outside = join(f.home, 'outside.jsonl')
    await writeFile(outside, line('session_meta', { id: A }) + started + progress)
    execFileSync('/usr/bin/sqlite3', [
      f.database,
      `UPDATE threads SET rollout_path='${outside}' WHERE id='${A}';`,
    ])
    snapshot = await createSessionReader({ codexHome: f.home })([A], now)
    expect(snapshot.sessions[0].state).toBe('unknown')
  })

  it('prioritizes each selected parent and reports exact counts when detail rows are bounded', async () => {
    const f = await fixture()
    const inserts = Array.from({ length: 320 }, (_, i) => {
      const id = '10000000-0000-4000-8000-' + String(i).padStart(12, '0')
      return `INSERT INTO threads VALUES ('${id}',NULL,'child-model','low','/private/example',NULL,NULL,NULL,NULL,0,100);INSERT INTO thread_spawn_edges VALUES ('${C}','${id}');`
    }).join('')
    execFileSync('/usr/bin/sqlite3', [f.database, inserts])
    const snapshot = await createSessionReader({ codexHome: f.home })([A, C], now)
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.sessions[0]).toMatchObject({
      id: A,
      subagentCount: 1,
      agentsTruncated: false,
      subagents: [{ id: B }],
    })
    expect(snapshot.sessions[1]).toMatchObject({
      id: C,
      subagentCount: 320,
      agentsTruncated: true,
    })
    expect(snapshot.sessions[1].subagents).toHaveLength(297)
  })

  it('does not create a missing database or query invalid IDs', async () => {
    const f = await fixture()
    const missing = join(f.home, 'missing')
    await expect(createSessionReader({ codexHome: missing })([A], now)).rejects.toThrow()
    await expect(stat(join(missing, 'state_5.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
    let queried = false
    const read = createSessionReader({
      query: async () => {
        queried = true
        return []
      },
    })
    expect(await read(["bad' SQL"], now)).toEqual({ sessions: [], truncated: false })
    expect(queried).toBe(false)
  })
})

const selectedHistory = (): History => ({
  threads: [
    {
      id: A,
      title: 'Selected chat',
      sourceKind: 'appServer',
      createdAt: now - 120000,
      updatedAt: now,
      liveActivity: null,
      navigation: 'localChat',
    },
  ],
  nextCursor: null,
  truncated: false,
})

describe('Codex observations channel lifecycle', () => {
  it('stays opt-in and keeps failures separate from history/account snapshots', async () => {
    let reads = 0
    const disabled = createCodexSessionsProvider({
      enabled: false,
      history: () => null,
      read: async () => {
        reads++
        throw Error('offline')
      },
    })
    expect((await disabled.poll!()).error).toBe('unconfigured')
    expect(reads).toBe(0)

    const provider = createCodexSessionsProvider({
      enabled: true,
      history: selectedHistory,
      read: async () => {
        throw Error('PRIVATE')
      },
      now: () => now,
    })
    expect(await provider.poll!()).toMatchObject({ sessions: [], error: 'offline', updatedAt: null })
    expect(provider.intervalMs).toBe(5000)
  })

  it('does not publish a late read after the channel stops', async () => {
    let release!: (value: { sessions: []; truncated: false }) => void
    const provider = createCodexSessionsProvider({
      enabled: true,
      history: selectedHistory,
      read: () =>
        new Promise((resolve) => {
          release = resolve
        }),
      now: () => now,
    })
    const pending = provider.poll!()
    provider.stop!()
    release({ sessions: [], truncated: false })
    expect(await pending).toMatchObject({ updatedAt: null, error: 'offline' })
  })
})
