/**
 * Host-side HTTP surface for dsh-my-rules.
 *
 * The browser half (client.js) renders a rule editor inside the plugin's own
 * detail page. It needs a way to read and write the rule files, so this module
 * publishes a small JSON API on the host's web server.
 *
 * Every write goes through the same rules-core helpers the agent-facing tool
 * uses, so the page and the agent can never disagree about the file format.
 */
import {
  loadActiveRules,
  loadRules,
  removeRule,
  resolveDir,
  slugify,
  writeRule,
} from './rules-core.js'

/** Stable Cordis provider name for this row. */
export const name = 'dsh-my-rules-api'

/** The route prefix every endpoint of this plugin owns. */
export const API_PREFIX = '/dsh-my-rules/api/v1'

/** The largest request body the API accepts, in bytes. */
const MAX_BODY_BYTES = 64 * 1024

/** Send one JSON response with a status code. */
function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

/**
 * Whether one request comes from the same origin as the host.
 *
 * The Desktop host serves its page from a custom protocol, where a same-origin
 * check would reject every request, so the gate is a no-op there and the
 * browser's own protections carry the load instead.
 */
function sameOrigin(request) {
  const host = request.headers.host
  const origin = request.headers.origin
  if (origin === undefined || host === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Read and parse one JSON request body, with a byte cap. */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** One rule as the page consumes it. */
function viewOf(rule) {
  return {
    slug: rule.slug,
    title: rule.title,
    enabled: rule.enabled,
    priority: rule.priority,
    body: rule.body,
  }
}

/**
 * Mount the rules API on the host's web server.
 *
 * @param ctx - The plugin context; 'webServer' publishes the routes.
 * @param config - The row's config; 'dir' overrides the rules directory.
 */
export function mountRulesApi(ctx, config = {}) {
  const dir = resolveDir(config.dir)

  ctx.inject(['webServer'], (webCtx) => {
    const register = (route) => webCtx.webServer.register(route)
    const rulesPath = API_PREFIX + '/rules'
    const rulePath = API_PREFIX + '/rule'

    /** Guard one request: method and origin. */
    const guard = (request, response, method) => {
      if (request.method !== method) {
        response.writeHead(405, { allow: method })
        response.end()
        return false
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'untrusted origin' })
        return false
      }
      return true
    }

    /**
     * /rules - GET lists the rules, POST creates one.
     *
     * One route per path, dispatching on the method inside: the host matches
     * routes by path, so registering the same path twice would shadow one of
     * the two handlers.
     */
    register({
      kind: 'exact',
      path: rulesPath,
      handler: async (request, response) => {
        if (request.method === 'GET') {
          try {
            const rules = await loadRules(dir)
            const active = await loadActiveRules(dir)
            sendJson(response, 200, {
              ok: true,
              dir,
              rules: rules.map(viewOf),
              active: active.map(rule => rule.slug),
            })
          } catch (error) {
            sendJson(response, 500, { error: String(error?.message ?? error) })
          }
          return
        }
        if (!guard(request, response, 'POST')) return
        try {
          const body = await readJsonBody(request)
          const title = typeof body?.title === 'string' ? body.title.trim() : ''
          const text = typeof body?.body === 'string' ? body.body.trim() : ''
          if (title.length === 0 || text.length === 0) {
            sendJson(response, 400, { error: 'a rule needs a title and a body' })
            return
          }
          const existing = await loadRules(dir)
          const requested = typeof body?.slug === 'string' ? body.slug.trim() : ''
          const slug = requested.length > 0 ? slugify(requested) : slugify(title)
          if (existing.some(rule => rule.slug === slug)) {
            sendJson(response, 409, { error: 'a rule named ' + slug + ' already exists' })
            return
          }
          const priority = Number.isFinite(Number(body?.priority)) ? Number(body.priority) : 100
          await writeRule(dir, slug, { title, body: text, enabled: true, priority })
          sendJson(response, 200, { ok: true, slug, rules: (await loadRules(dir)).map(viewOf) })
        } catch (error) {
          sendJson(response, 500, { error: String(error?.message ?? error) })
        }
      },
    })

    /** POST /rule - update, enable, disable or delete one rule. */
    register({
      kind: 'exact',
      path: rulePath,
      handler: async (request, response) => {
        if (!guard(request, response, 'POST')) return
        try {
          const body = await readJsonBody(request)
          const slug = typeof body?.slug === 'string' ? body.slug.trim() : ''
          const action = typeof body?.action === 'string' ? body.action : ''
          if (slug.length === 0) {
            sendJson(response, 400, { error: 'a rule id is required' })
            return
          }
          const rules = await loadRules(dir)
          const target = rules.find(rule => rule.slug === slug)
          if (target === undefined) {
            sendJson(response, 404, { error: 'no rule named ' + slug })
            return
          }
          if (action === 'delete') {
            await removeRule(dir, slug)
          } else if (action === 'enable' || action === 'disable') {
            await writeRule(dir, slug, { ...target, enabled: action === 'enable' })
          } else if (action === 'update') {
            const title = typeof body?.title === 'string' && body.title.trim().length > 0
              ? body.title.trim()
              : target.title
            const text = typeof body?.body === 'string' && body.body.trim().length > 0
              ? body.body.trim()
              : target.body
            const priority = Number.isFinite(Number(body?.priority)) ? Number(body.priority) : target.priority
            await writeRule(dir, slug, { title, body: text, enabled: target.enabled, priority })
          } else {
            sendJson(response, 400, { error: 'unknown action ' + action })
            return
          }
          sendJson(response, 200, { ok: true, slug, rules: (await loadRules(dir)).map(viewOf) })
        } catch (error) {
          sendJson(response, 500, { error: String(error?.message ?? error) })
        }
      },
    })
  })
}
