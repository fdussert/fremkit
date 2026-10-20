import { azureDevOpsType } from './azure-devops.js'
import { bambuType } from './bambu.js'
import { githubType } from './github.js'
import { icsType } from './ics.js'
import { synologyType } from './synology.js'
import { openAIShellsmithType } from './openai-shellsmith.js'
import type { ConnectionType } from '../types.js'

/** Every connection type the server ships with. */
export function defaultConnectionTypes(): ConnectionType[] {
  return [azureDevOpsType, bambuType, githubType, icsType, synologyType, openAIShellsmithType]
}
