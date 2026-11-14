import { execFile } from 'node:child_process'

export type Runner = (script: string) => Promise<string>

/**
 * Runs one script in a process of its own: for what a person asks for (play, pause, a volume),
 * which is rare. Never for a poll: each `osascript` started registers with LaunchServices, and a
 * Mac has about a million registrations in it before it stops starting applications until it is
 * rebooted. What runs on a clock goes through `createScriptHost()` in osascript-host.ts.
 */
export const osascript: Runner = (script) =>
  new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message))
      else resolve(stdout.trim())
    })
  })
