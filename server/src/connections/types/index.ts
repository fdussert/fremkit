import { azureDevOpsType } from './azure-devops.js'
import { bambuType } from './bambu.js'
import { githubType } from './github.js'
import { homeyType } from './homey.js'
import { icsType } from './ics.js'
import { synologyType } from './synology.js'
import type { ConnectionType } from '../types.js'

/** Every connection type the server ships with. */
export function defaultConnectionTypes(): ConnectionType[] {
  return [azureDevOpsType, bambuType, githubType, homeyType, icsType, synologyType]
}
