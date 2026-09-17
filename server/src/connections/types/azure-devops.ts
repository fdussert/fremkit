import { createAzureDevOpsProvider } from '../../providers/azure-devops.js'
import { ADO_API_VERSION, ADO_TIMEOUT_MS } from '../../providers/azure-devops.js'
import { USER_AGENT } from '../../version.js'
import { tr } from '../../i18n.js'
import type { ConnectionType, TestResult } from '../types.js'

export interface AdoTestDeps { fetchFn?: typeof fetch }

/**
 * Azure DevOps, personal access token with the Build (read) scope.
 *
 * The PAT is sent as the password of an HTTP Basic pair with an empty user name, which is what
 * `dev.azure.com` expects. It is never logged: even the network error is reduced to a phrase.
 */
export const azureDevOpsType: ConnectionType = {
  id: 'azure-devops',
  name: 'Azure DevOps',
  description: { fr: 'Runs de pipeline d’un projet Azure DevOps', en: 'Pipeline runs of an Azure DevOps project' },
  icon: 'layout-grid',
  fields: [
    {
      key: 'organization',
      label: { fr: 'Organisation', en: 'Organization' },
      required: true,
      placeholder: 'contoso',
      help: {
        fr: 'Le segment après dev.azure.com/ dans l’URL du projet.',
        en: 'The segment after dev.azure.com/ in the project URL.',
      },
    },
    {
      key: 'project',
      label: { fr: 'Projet', en: 'Project' },
      required: true,
      placeholder: { fr: 'mon-projet', en: 'my-project' },
    },
    {
      key: 'pat',
      label: { fr: 'Jeton d’accès personnel', en: 'Personal access token' },
      secret: true,
      required: true,
      help: {
        fr: 'Droit « Build » en lecture suffit. Se crée dans Paramètres utilisateur → Personal access tokens.',
        en: 'Read access to “Build” is enough. Create one under User settings → Personal access tokens.',
      },
    },
  ],

  async test(fields, secrets, deps: AdoTestDeps = {}): Promise<TestResult> {
    const fetchFn = deps.fetchFn ?? fetch
    const org = encodeURIComponent(fields.organization ?? '')
    const project = encodeURIComponent(fields.project ?? '')
    const url = `https://dev.azure.com/${org}/${project}/_apis/build/definitions?$top=1&api-version=${ADO_API_VERSION}`
    let res: Response
    try {
      res = await fetchFn(url, {
        headers: {
          Authorization: `Basic ${Buffer.from(`:${secrets.pat ?? ''}`).toString('base64')}`,
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
        signal: AbortSignal.timeout(ADO_TIMEOUT_MS),
      })
    } catch {
      // Deliberately not the error message: it can carry the URL, and the URL carries the org.
      return { ok: false, error: tr(undefined, 'ado.unreachable') }
    }
    await res.body?.cancel().catch(() => { /* already closed */ })
    if (res.ok) return { ok: true, detail: tr(undefined, 'ado.connected', { organization: fields.organization ?? '', project: fields.project ?? '' }) }
    if (res.status === 401 || res.status === 403) return { ok: false, error: tr(undefined, 'ado.patRefused') }
    if (res.status === 404) return { ok: false, error: tr(undefined, 'ado.notFound') }
    return { ok: false, error: tr(undefined, 'ado.unexpected', { status: res.status }) }
  },

  createProvider: (ctx) => createAzureDevOpsProvider(ctx),
}
