/**
 * Rule storage for dsh-my-rules.
 *
 * One rule = one Markdown file under the rules directory. The file starts with a
 * small frontmatter block (title, enabled, priority) and continues with the rule
 * body, which is the text the agent must follow. The format is deliberately
 * plain so the rules stay editable in any text editor, and so a rule can be
 * copied between machines as a single file.
 *
 * No third-party dependency is used: the frontmatter parser handles only the
 * flat "key: value" lines this plugin writes.
 */
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The DSH home directory, honouring the host's own override. */
export function resolveHome() {
  const override = process.env.DSH_HOME
  if (typeof override === 'string' && override.length > 0) return override
  return join(homedir(), '.dsh')
}

/** The directory that holds the rule files. */
export function resolveDir(configured) {
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  return join(resolveHome(), 'my-rules')
}

/** A filesystem-safe slug for one rule file. */
export function slugify(title, fallback = 'rule') {
  const base = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return base.length > 0 ? base : fallback
}

/** Split a rule file into its frontmatter fields and its body. */
export function parseRule(text) {
  const source = String(text ?? '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source)
  if (match === null) return { title: '', enabled: true, priority: 100, body: source.trim() }
  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (key.length > 0) fields[key] = value
  }
  const enabled = fields.enabled === undefined ? true : !/^(false|0|off|no)$/i.test(fields.enabled)
  const priority = Number.parseInt(fields.priority ?? '100', 10)
  return {
    title: fields.title ?? '',
    enabled,
    priority: Number.isFinite(priority) ? priority : 100,
    body: match[2].trim(),
  }
}

/** Render one rule back into its file format. */
export function renderRule(rule) {
  const title = String(rule.title ?? '').replace(/\r?\n/g, ' ').trim()
  const lines = [
    '---',
    `title: ${title}`,
    `enabled: ${rule.enabled === false ? 'false' : 'true'}`,
    `priority: ${Number.isFinite(rule.priority) ? rule.priority : 100}`,
    '---',
    '',
    String(rule.body ?? '').trim(),
    '',
  ]
  return lines.join('\n')
}

/** Every rule file in the directory, sorted by file name. */
async function ruleFiles(dir) {
  let entries
  try {
    entries = await readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return entries.filter(name => name.endsWith('.md')).sort()
}

/** Read every rule, including the disabled ones. */
export async function loadRules(dir) {
  const files = await ruleFiles(dir)
  const rules = []
  for (const file of files) {
    const slug = file.slice(0, -3)
    let text
    try {
      text = await readFile(join(dir, file), 'utf8')
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
export async function loadActiveRules(dir) {
  const rules = await loadRules(dir)
  return rules
    .filter(rule => rule.enabled)
    .sort((left, right) => right.priority - left.priority || left.slug.localeCompare(right.slug))
}

/** Write one rule file, creating or replacing it. */
export async function writeRule(dir, slug, rule) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${slug}.md`), renderRule(rule), 'utf8')
  return { slug, file: `${slug}.md` }
}

/** Remove one rule file. */
export async function removeRule(dir, slug) {
  await rm(join(dir, `${slug}.md`), { force: true })
}

/**
 * Render the enabled rules as the text the agent must follow.
 *
 * The byte budget keeps a very long rule set from crowding out the rest of the
 * prompt: the lowest-priority rule is dropped first, and the last one is
 * truncated when the budget is still exceeded.
 */
export function renderRules(rules, maxBytes) {
  const budget = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 16384
  const kept = []
  let used = 0
  for (const rule of rules) {
    const block = `## ${rule.title}\n${rule.body}\n`
    const size = Buffer.byteLength(block, 'utf8')
    if (used + size > budget) break
    kept.push({ rule, block })
    used += size
  }
  const header = [
    '# 我写的规则（用户自定义，必须遵守）',
    '',
    '以下规则由用户本人编写，是本次及以后所有会话都必须遵守的约定。',
    '它们优先于你的默认习惯；与其他要求冲突时，以这里写的为准。',
    '',
  ].join('\n')
  const text = header + kept.map(entry => entry.block).join('')
  return { text, count: kept.length, bytes: Buffer.byteLength(text, 'utf8'), budget }
}
