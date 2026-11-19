/**
 * dsh-my-rules — personal, editable rule files for DeepSeek Harness.
 *
 * WHAT THIS IS. One rule = one Markdown file under the rules directory
 * (~/.dsh/my-rules by default). A rule file carries a small frontmatter block
 * (title, enabled, priority) and a body: the body is the instruction the agent
 * must follow. The user edits those files freely — in the plugin's own tool
 * surface, in a slash command, or in any text editor.
 *
 * HOW IT REACHES THE AGENT. The enabled rules are rendered into one system
 * prompt section, registered through the host's own "systemPrompt" service, so
 * every agent in every session sees them without spending a round trip and
 * without the rules entering the conversation history as chatter.
 *
 * WHY IT SURVIVES AN UPGRADE. The bundle lives in the profile's node_modules,
 * not inside the application, and it uses only published host contracts:
 * ctx.systemPrompt.section(), ctx.tools.register(), ctx.commands.register(),
 * and the agent/created + agent/disposed lifecycle events.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseRule, renderRule, resolveDir, slugify } from './rules-core.js'
import { mountRulesApi } from './rules-api.js'

/** Stable Cordis provider name. */
export const name = 'dsh-my-rules'

/** Host services this plugin needs. */
export const inject = ['systemPrompt', 'tools', 'commands', 'webServer']

const DEFAULTS = {
  dir: '',
  maxBytes: 16384,
  seed: true,
}

/**
 * The starter rules written into an empty rules directory.
 *
 * They exist so a fresh install already carries the user's first discipline
 * instead of an empty prompt section.
 */
const STARTER_RULES = [
  {
    title: '先搜索现有答案，再证实',
    priority: 200,
    body: [
      '面对任何问题，先搜索是否已有现成答案（现有插件、现有代码、现有文档、官方能力）。',
      '只有在确实找不到答案时，才自己动手实现或求证，并说明为什么现有答案不适用。',
    ].join('\n'),
  },
  {
    title: '先说明方案再执行',
    priority: 150,
    body: [
      '涉及改动系统状态、删除数据、批量写文件或多步操作时，先把打算怎么做讲清楚，等确认后再执行。',
      '只读调查、检索、验证可以直接做。',
    ].join('\n'),
  },
]

/**
 * Every rule file in the directory, parsed.
 *
 * The read is synchronous on purpose: the system prompt section is rendered
 * during prompt assembly, which is not an async context this plugin controls.
 *
 * @param {string} dir - The rules directory.
 * @returns {Array<object>} The rules, including the disabled ones.
 */
function readRules(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const rules = []
  for (const file of entries.filter(name => name.endsWith('.md')).sort()) {
    const slug = file.slice(0, -3)
    let text
    try {
      text = readFileSync(join(dir, file), 'utf8')
    } catch {
      continue
    }
    const parsed = parseRule(text)
    rules.push({
      slug,
      file,
      title: parsed.title || slug,
      enabled: parsed.enabled,
      priority: parsed.priority,
      body: parsed.body,
    })
  }
  return rules
}

/** The rules that apply right now, highest priority first. */
function activeRules(dir) {
  return readRules(dir)
    .filter(rule => rule.enabled)
    .sort((left, right) => right.priority - left.priority || left.slug.localeCompare(right.slug))
}

/**
 * Render the enabled rules as the text the agent must follow.
 *
 * The byte budget keeps a very long rule set from crowding out the rest of the
 * prompt: the lowest-priority rule is dropped first.
 */
function renderRules(dir, maxBytes) {
  const budget = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULTS.maxBytes
  const header = [
    '# 我写的规则（用户自定义，必须遵守）',
    '',
    '以下规则由用户本人编写，是本次及以后所有会话都必须遵守的约定。',
    '它们优先于你的默认习惯；与其他要求冲突时，以这里写的为准。',
    '',
  ].join('\n')
  const blocks = []
  let used = Buffer.byteLength(header, 'utf8')
  for (const rule of activeRules(dir)) {
    const block = `## ${rule.title}\n${rule.body}\n\n`
    const size = Buffer.byteLength(block, 'utf8')
    if (used + size > budget) break
    blocks.push(block)
    used += size
  }
  return header + blocks.join('')
}

/** Write one rule file, creating or replacing it. */
function writeRule(dir, slug, rule) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${slug}.md`), renderRule(rule), 'utf8')
}

/**
 * Mount the plugin.
 *
 * @param ctx - The Cordis context.
 * @param config - The row's config; every field is optional.
 */
export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...(config ?? {}) }
  const dir = resolveDir(options.dir)
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULTS.maxBytes

  // The JSON API the rule editor page writes to. It lives in this same row so
  // the host needs no second plugin entry for it.
  mountRulesApi(ctx, { dir: options.dir })

  // The rules are plain files the user may edit at any time, so the section is
  // re-read on each prompt assembly instead of being cached.
  ctx.inject(['systemPrompt'], (scoped) => {
    scoped.effect(() => scoped.systemPrompt.section({
      name: 'my-rules:user-rules',
      order: 3200,
      interpolate: false,
      text: () => renderRules(dir, maxBytes),
    }), 'my-rules: user rules section')
  })

  // One tool the agent can call on the user's behalf ("add this rule for me").
  ctx.inject(['tools'], (scoped) => {
    const entries = new Map()

    const attach = async (agent) => {
      if (entries.has(agent)) return
      const fiber = agent.ctx.plugin({
        inject: ['tools'],
        apply(inner) {
          const dispose = inner.tools.register({
            name: 'my_rules',
            description: [
              "Read and manage the user's personal rule files.",
              'Actions: list (show every rule), add (create one from a title and body),',
              'update (rewrite the body of one rule), enable, disable, delete.',
              "The enabled rules are injected into every agent's system prompt, so a rule",
              'added here applies to this and every later session.',
            ].join(' '),
            parameters: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: ['list', 'add', 'update', 'enable', 'disable', 'delete'],
                  description: 'What to do.',
                },
                slug: {
                  type: 'string',
                  description: 'The rule id. Required for update, enable, disable and delete; optional for add.',
                },
                title: {
                  type: 'string',
                  description: 'The rule title. Required for add.',
                },
                body: {
                  type: 'string',
                  description: 'The rule text the agent must follow. Required for add and update.',
                },
              },
              additionalProperties: false,
            },
            output: {
              schema: { type: 'object' },
              render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
            },
            execute: async (args) => {
              const action = typeof args?.action === 'string' ? args.action : ''
              const rules = readRules(dir)
              if (action === 'list') {
                return {
                  ok: true,
                  action,
                  dir,
                  rules,
                  active: activeRules(dir).map(rule => rule.slug),
                }
              }
              const slug = typeof args?.slug === 'string' ? args.slug.trim() : ''
              if (action === 'add') {
                const title = typeof args?.title === 'string' ? args.title.trim() : ''
                const body = typeof args?.body === 'string' ? args.body.trim() : ''
                if (title.length === 0 || body.length === 0) {
                  return { ok: false, action, error: 'add needs both a title and a body.' }
                }
                const target = slug.length > 0 ? slugify(slug) : slugify(title)
                if (rules.some(rule => rule.slug === target)) {
                  return { ok: false, action, error: `A rule named "${target}" already exists; use update instead.` }
                }
                writeRule(dir, target, { title, body, enabled: true, priority: 100 })
                return { ok: true, action, slug: target, rules: readRules(dir) }
              }
              if (slug.length === 0) return { ok: false, action, error: 'This action needs a rule id.' }
              const target = rules.find(rule => rule.slug === slug)
              if (target === undefined) return { ok: false, action, error: `No rule named "${slug}".` }
              if (action === 'update') {
                const body = typeof args?.body === 'string' ? args.body.trim() : ''
                if (body.length === 0) return { ok: false, action, error: 'update needs a body.' }
                writeRule(dir, target.slug, { ...target, body })
                return { ok: true, action, slug: target.slug, rules: readRules(dir) }
              }
              if (action === 'enable' || action === 'disable') {
                writeRule(dir, target.slug, { ...target, enabled: action === 'enable' })
                return { ok: true, action, slug: target.slug, rules: readRules(dir) }
              }
              if (action === 'delete') {
                rmSync(join(dir, `${target.slug}.md`), { force: true })
                return { ok: true, action, slug: target.slug, rules: readRules(dir) }
              }
              return { ok: false, action, error: `Unknown action "${action}".` }
            },
          })
          const entry = entries.get(agent)
          if (entry !== undefined) entry.dispose = dispose
        },
      })
      entries.set(agent, { fiber })
      await fiber
    }

    scoped.on('agent/created', async ({ agent }) => {
      await attach(agent)
    })
    scoped.on('agent/disposed', async ({ agent }) => {
      const entry = entries.get(agent)
      entries.delete(agent)
      entry?.dispose?.()
      await entry?.fiber?.dispose()
    })
  })

  // A slash command, so the user can manage the rules from the composer.
  ctx.inject(['commands'], (scoped) => {
    scoped.effect(() => scoped.commands.register({
      name: 'myrules',
      description: '查看或管理我的规则',
      input: { hint: '留空查看全部；add <标题>｜<正文> 新增；del <规则号> 删除' },
      handler: async (invocation) => {
        const raw = String(invocation?.rawInput ?? '').trim()
        if (raw.length === 0) {
          const rules = readRules(dir)
          if (rules.length === 0) return { kind: 'success', text: '还没有任何规则文件。' }
          const lines = ['我的规则：', '']
          rules.forEach((rule, index) => {
            lines.push(`${index + 1}. ${rule.enabled ? '[启用]' : '[停用]'} ${rule.title}  (id: ${rule.slug})`)
          })
          lines.push('', `规则目录：${dir}`)
          return { kind: 'success', text: lines.join('\n') }
        }
        const add = /^(?:add|新增|添加)\s+([\s\S]+)$/i.exec(raw)
        if (add !== null) {
          const parts = add[1].split(/[｜|]/, 2)
          const title = (parts[0] ?? '').trim()
          const body = (parts[1] ?? '').trim()
          if (title.length === 0 || body.length === 0) {
            return { kind: 'error', text: '用法：/myrules add <标题>｜<正文>' }
          }
          const slug = slugify(title)
          if (readRules(dir).some(rule => rule.slug === slug)) {
            return { kind: 'error', text: `规则 "${slug}" 已存在。` }
          }
          writeRule(dir, slug, { title, body, enabled: true, priority: 100 })
          return { kind: 'success', text: `已新增规则「${title}」，立即生效。` }
        }
        const del = /^(?:del|delete|删除)\s+(\S+)$/i.exec(raw)
        if (del !== null) {
          const target = readRules(dir).find(rule => rule.slug === del[1])
          if (target === undefined) return { kind: 'error', text: `没有找到规则 "${del[1]}"。` }
          rmSync(join(dir, `${target.slug}.md`), { force: true })
          return { kind: 'success', text: `已删除规则「${target.title}」。` }
        }
        return { kind: 'error', text: '用法：/myrules 或 /myrules add <标题>｜<正文> 或 /myrules del <规则号>' }
      },
    }), 'my-rules: command')
  })

  // Seed the starter rules the first time the directory is empty.
  if (options.seed === true && readRules(dir).length === 0) {
    mkdirSync(dir, { recursive: true })
    for (const rule of STARTER_RULES) {
      const slug = slugify(rule.title)
      if (readRules(dir).some(item => item.slug === slug)) continue
      writeRule(dir, slug, { title: rule.title, body: rule.body, enabled: true, priority: rule.priority })
    }
  }
}
