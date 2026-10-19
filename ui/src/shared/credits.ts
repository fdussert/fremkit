/**
 * Who wrote Fremkit, as the admin's About section and the README's Credits section both name
 * them. Handles rather than names, the same ones the registry puts on a widget's card.
 *
 * Somebody whose first pull request lands is added here, in the same pull request or the next;
 * `credits.test.ts` then refuses a README that does not name them too.
 */
import { version } from '../../package.json'

export interface Person {
  handle: string
  /** GitHub login, which is not always the handle. */
  github: string
}

export const MAINTAINER: Person = { handle: 'usul', github: 'fdussert' }

export const CONTRIBUTORS: readonly Person[] = [
  { handle: 'FlorianBruniaux', github: 'FlorianBruniaux' },
  { handle: 'mcouzinet', github: 'mcouzinet' },
]

export const REPOSITORY = 'https://github.com/fdussert/fremkit'

/** The Sietch: the registry's own repository, where widgets and themes are published. */
export const REGISTRY_REPOSITORY = 'https://github.com/fdussert/fremkit-sietch'

/** A new issue on the bug form, which asks for what the diagnostics report holds. */
export const BUG_REPORT_URL = `${REPOSITORY}/issues/new?template=bug.yml`

/** The UI's own version, bumped with the three others at every release. */
export const VERSION: string = version
