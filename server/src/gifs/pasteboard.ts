import { execFile } from 'node:child_process'

/** Runs a JavaScript for Automation script with its arguments. Never through a shell. */
export type JxaRunner = (script: string, args: string[]) => Promise<void>

const OSASCRIPT_TIMEOUT_MS = 5000

/**
 * Puts one GIF on the general pasteboard as a single item carrying both the file's URL and its
 * bytes. Teams (and Slack, Messages) paste the file reference animated; given only the bytes they
 * keep the first frame. Apps that read image data still find it on the same item.
 *
 * The path arrives as `argv[0]`, never spliced into the text. The type names are bridged with
 * `$()`: a bare JS string is silently dropped for `public.file-url`.
 */
export const GIF_PASTE_SCRIPT = `ObjC.import('AppKit')
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0])
  const data = $.NSData.dataWithContentsOfFile(argv[0])
  if (data.isNil()) throw new Error('unreadable')
  const item = $.NSPasteboardItem.alloc.init
  item.setDataForType(data, $('com.compuserve.gif'))
  item.setStringForType(url.absoluteString, $('public.file-url'))
  const pb = $.NSPasteboard.generalPasteboard
  pb.clearContents
  if (!pb.writeObjects($([item]))) throw new Error('write failed')
}`

export const runJxa: JxaRunner = (script, args) =>
  new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, ...args], { timeout: OSASCRIPT_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message))
      else resolve()
    })
  })

export function writeGifToPasteboard(path: string, run: JxaRunner = runJxa): Promise<void> {
  return run(GIF_PASTE_SCRIPT, [path])
}
