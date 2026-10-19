/**
 * The access secret, wired into the app: the hook every request passes, and the two routes that
 * turn the secret into a browser session.
 *
 * Kept out of `guard.ts` on purpose. The guard is about *where* a request comes from (Host,
 * Origin); this is about *who* sent it, and applies to the loopback listener only. A future
 * listener with its own credentials (paired devices) passes `appliesTo` and keeps its own rules.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { CODE_TTL_MS, isPublicRoute, isWellFormedNonce, safeNext, type AccessGate } from './access.js'
import { tr, serverLocale } from '../i18n.js'

/** What a refused request is told about how to authenticate. The helper's probe looks for it. */
export const ACCESS_CHALLENGE = 'Bearer realm="fremkit"'

/** The page a browser lands on without the secret. No script, nothing to reload into a loop. */
function refusalPage(expired: boolean): string {
  const fr = expired
    ? 'Ce lien a expiré ou a déjà servi. Rouvrez Fremkit depuis le menu <b>F</b> de la barre des menus.'
    : 'Ouvrez Fremkit depuis le menu <b>F</b> de la barre des menus (<i>Ouvrir l’admin dans le navigateur</i>), ou avec <code>pnpm open</code> dans le dépôt.'
  const en = expired
    ? 'This link has expired or was already used. Open Fremkit again from the <b>F</b> menu in the menu bar.'
    : 'Open Fremkit from the <b>F</b> menu in the menu bar (<i>Open the admin in the browser</i>), or with <code>pnpm open</code> in the repository.'
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fremkit</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;background:#0b0d10;color:#e8e6e1;max-width:36rem;margin:15vh auto;padding:0 1rem}code{color:#d9b36a}</style>
</head><body><h1>Fremkit</h1><p lang="fr">${fr}</p><p lang="en">${en}</p></body></html>`
}

function refuse(req: FastifyRequest, reply: FastifyReply, expired = false): FastifyReply {
  reply.code(401).header('www-authenticate', ACCESS_CHALLENGE).header('cache-control', 'no-store')
  const path = req.url.split('?')[0]
  const wantsPage = !path.startsWith('/api/') && path !== '/ws' && /text\/html/.test(String(req.headers.accept ?? ''))
  if (wantsPage) {
    return reply
      .type('text/html; charset=utf-8')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
      .send(refusalPage(expired))
  }
  return reply.send({ error: tr(serverLocale(), 'http.unauthorized') })
}

export interface AccessGateWiring {
  gate: AccessGate
  /** Which requests the secret is asked of. Every one, until a listener with its own rules exists. */
  appliesTo?: (req: FastifyRequest) => boolean
}

/**
 * Adds the gate's hook and routes to `app` itself, not to an encapsulated child: the hook has to
 * run before every route, the static UI and the WebSocket upgrade included. Call it after the
 * Host check, so a rebinding attempt is still told 421 rather than 401.
 */
export function installAccessGate(app: FastifyInstance, { gate, appliesTo = () => true }: AccessGateWiring): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!appliesTo(req)) return
    if (isPublicRoute(req.method, req.routeOptions.url)) return
    if (gate.isAuthorized(req.headers)) return
    return refuse(req, reply)
  })

  /**
   * A one-time code for `/auth`, for a holder of the secret who wants to hand a browser a
   * session without putting the secret itself in a URL — the helper's "open in the browser",
   * `pnpm open`, `scripts/kiosk.sh`. Behind the gate like everything else.
   */
  app.post('/api/auth/code', async (req, reply) => {
    reply.header('cache-control', 'no-store')
    // The secret itself, not a session: a session that leaked (another loopback port sees the
    // cookie) must not be able to open sessions of its own and outlive its expiry.
    if (!gate.hasBearer(req.headers)) return refuse(req, reply)
    return { code: gate.mintCode(), expiresInSeconds: Math.floor(CODE_TTL_MS / 1000) }
  })

  /**
   * The server proves it holds the secret, before anyone shows it theirs.
   *
   * The helper and anything else that holds the secret ask this first, with a random nonce and
   * no credential, and send the bearer only to a listener whose answer checks out. Something
   * else on the port — another account's program that bound it while ours was down — cannot
   * answer, so it is never handed the secret and never shown as Fremkit. The answer is a MAC
   * under a label of its own (see `accessProof`): it reveals nothing about the secret and is
   * good for nothing but this question. Public, and only on the loopback listener.
   */
  app.get<{ Querystring: { nonce?: string } }>('/auth/proof', async (req, reply) => {
    reply.header('cache-control', 'no-store')
    const nonce = req.query.nonce
    if (!isWellFormedNonce(nonce)) return reply.code(400).send({ error: tr(serverLocale(), 'proxy.badRequest') })
    return { proof: gate.prove(nonce) }
  })

  /** Ends the caller's own session (signing out) and clears its cookie. */
  app.delete('/api/auth/session', async (req, reply) => {
    const id = gate.sessionOf(req.headers)
    if (id !== undefined) gate.revokeSession(id)
    return reply.header('cache-control', 'no-store').header('set-cookie', gate.clearCookieHeader()).code(204).send()
  })

  /**
   * Redeems a one-time code: opens a session, sets its cookie and sends the browser on to `next`,
   * a path on this server. The code is gone whether it worked or not. Nothing about it is logged: the request
   * log drops the query string (see `logging.ts`).
   */
  app.get<{ Querystring: { code?: string; next?: string } }>('/auth', async (req, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
    if (!gate.redeem(req.query.code)) return refuse(req, reply, true)
    return reply
      .header('set-cookie', gate.setCookieHeader(gate.openSession()))
      .redirect(safeNext(req.query.next), 303)
  })
}
