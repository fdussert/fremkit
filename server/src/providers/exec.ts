import { execFile } from 'node:child_process'

/**
 * Runs one command and hands back its stdout.
 *
 * Providers that read the Mac through command-line tools take one of these, so their tests can
 * feed them a captured string instead of running anything. `execFile` and not a shell: the
 * arguments are passed as an array and never re-parsed, so nothing a caller supplies can be read
 * as shell syntax.
 */
export type Exec = (file: string, args: string[]) => Promise<string>

export const execCommand: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message))
      else resolve(stdout)
    })
  })
