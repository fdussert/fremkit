import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppId } from './apps.js'
import { exists } from './util.js'

/**
 * Which application a project's root suggests, from the NAMES of the entries at its top level:
 * the first rule that matches and has an installed application wins. Never a file's contents,
 * never a subfolder's listing.
 */
interface Rule {
  matches: (names: Set<string>, exts: Set<string>) => boolean
  /** Candidates in order of preference: the first installed one is suggested. */
  apps: AppId[]
}

const has = (...wanted: string[]) => (names: Set<string>) => wanted.some((n) => names.has(n))
const GRADLE = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']

export const SUGGESTION_RULES: Rule[] = [
  { matches: (_n, e) => e.has('.sln') || e.has('.csproj') || e.has('.fsproj'), apps: ['jetbrains-rider'] },
  { matches: (n, e) => e.has('.xcodeproj') || e.has('.xcworkspace') || n.has('Package.swift'), apps: ['xcode'] },
  { matches: has('Cargo.toml'), apps: ['jetbrains-rustrover'] },
  { matches: has('go.mod'), apps: ['jetbrains-goland'] },
  { matches: has('pyproject.toml', 'requirements.txt'), apps: ['jetbrains-pycharm', 'jetbrains-pycharm-ce'] },
  { matches: has('composer.json'), apps: ['jetbrains-phpstorm'] },
  { matches: has('Gemfile'), apps: ['jetbrains-rubymine'] },
  { matches: has(...GRADLE, 'pom.xml'), apps: ['jetbrains-idea', 'jetbrains-idea-ce'] },
  { matches: has('CMakeLists.txt'), apps: ['jetbrains-clion'] },
]

/** An Android build, plainly: a manifest at the root, or the usual `app` module's one. */
async function isAndroid(path: string, names: Set<string>): Promise<boolean> {
  if (names.has('AndroidManifest.xml')) return true
  if (!GRADLE.some((n) => names.has(n)) || !names.has('app')) return false
  // One fixed path, checked for existence only: still no listing below the root.
  return exists(join(path, 'app', 'src', 'main', 'AndroidManifest.xml'))
}

/** The suggested application for one project, or null when its root names none installed. */
export async function suggestApp(path: string, installed: readonly AppId[]): Promise<AppId | null> {
  let entries: string[]
  try {
    entries = await readdir(path)
  } catch {
    return null
  }
  const names = new Set(entries)
  const exts = new Set(entries.map((n) => n.slice(n.lastIndexOf('.'))).filter((e) => e.length > 1))
  if (installed.includes('jetbrains-android-studio') && await isAndroid(path, names)) return 'jetbrains-android-studio'
  for (const rule of SUGGESTION_RULES) {
    if (!rule.matches(names, exts)) continue
    const app = rule.apps.find((a) => installed.includes(a))
    if (app) return app
  }
  return null
}
