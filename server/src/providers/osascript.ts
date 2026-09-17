import { execFile } from 'node:child_process'

export type Runner = (script: string) => Promise<string>

export const osascript: Runner = (script) =>
  new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message))
      else resolve(stdout.trim())
    })
  })
