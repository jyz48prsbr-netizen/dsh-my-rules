/**
 * Browser half: a rule editor inside this plugin's own detail page.
 *
 * The page lists every rule the user wrote, lets them edit the title and
 * body in place, and adds as many more as they want: the "add" button
 * appends one more editable card every time it is pressed, so the list grows
 * from one to two to ten and on without any limit.
 *
 * Writes go to the host through this plugin's own JSON API; the agent-facing
 * tool and this page therefore always agree about what is on disk.
 */
window.__ModuleLoader__.load({
  id: 'dsh-my-rules',
  factory(require) {
    const react = require('react')
    const { useState, useEffect, useCallback, useMemo } = react

    const NS = 'myRules'
    const API = '/dsh-my-rules/api/v1'

    /** The locale namespace this panel draws its text from. */
    const DICT = {
      zh: {
        title: '我的规则',
        hint: '这些规则由你本人编写，会注入到每一个会话的系统提示词里，所有 Agent 都必须遵守。',
        add: '＋ 新增规则',
        save: '保存',
        saved: '已保存',
        cancel: '取消',
        edit: '编辑',
        remove: '删除',
        enable: '启用',
        disable: '停用',
        loading: '正在加载规则…',
        empty: '还没有任何规则。点上面的按钮加一条。',
        titlePlaceholder: '规则标题',
        bodyPlaceholder: '规则正文：Agent 必须遵守的约定。',
        priority: '优先级',
        confirmDelete: '确定删除这条规则吗？删除后不再注入任何会话。',
        error: '出错了：',
        newRule: '新规则',
      },
      en: {
        title: 'My rules',
        hint: 'You wrote these rules yourself. They are injected into every session system prompt, so every agent must follow them.',
        add: '＋ Add rule',
        save: 'Save',
        saved: 'Saved',
        cancel: 'Cancel',
        edit: 'Edit',
        remove: 'Delete',
        enable: 'Enable',
        disable: 'Disable',
        loading: 'Loading rules…',
        empty: 'No rules yet. Use the button above to add one.',
        titlePlaceholder: 'Rule title',
        bodyPlaceholder: 'Rule body: what the agent must follow.',
        priority: 'Priority',
        confirmDelete: 'Delete this rule? It will no longer be injected into any session.',
        error: 'Error: ',
        newRule: 'New rule',
      },
    }

    /** Resolve one API path against the current document base. */
    const api = (path) => {
      if (typeof document === 'undefined') return path
      return new URL(path.replace(/^\/+/, ''), document.baseURI).pathname
    }

    /** One JSON request against this plugin's host API. */
    const request = async (path, init) => {
      const response = await fetch(api(path), {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      })
      const text = await response.text()
      let payload = {}
      try { payload = text.length > 0 ? JSON.parse(text) : {} } catch { payload = {} }
      if (!response.ok) throw new Error(payload.error || ('HTTP ' + response.status))
      return payload
    }

    /** Inline styles; the host's CSS variables keep the panel on theme. */
    const s = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '12px', width: '100%' },
      head: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' },
      title: { fontSize: '15px', fontWeight: 650, color: 'var(--dsw-alias-label-primary, #1f2329)' },
      sub: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #8a919f)', lineHeight: '18px', marginTop: '4px' },
      btn: { padding: '5px 11px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-2, #d5d9e0)', background: 'var(--dsw-alias-bg-layer-1, #fff)', cursor: 'pointer', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #4e5969)' },
      btnPrimary: { padding: '5px 11px', borderRadius: '8px', border: '1px solid transparent', background: 'var(--dsw-alias-brand-6, #3370ff)', color: '#fff', cursor: 'pointer', fontSize: '12px', fontWeight: 550 },
      btnDanger: { padding: '5px 11px', borderRadius: '8px', border: '1px solid var(--dsw-alias-danger-4, #fbaca3)', background: 'transparent', cursor: 'pointer', fontSize: '12px', color: 'var(--dsw-alias-danger-5, #f53f3f)' },
      input: { width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-2, #d5d9e0)', fontSize: '13px', background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-label-primary, #1f2329)' },
      textarea: { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-2, #d5d9e0)', fontSize: '13px', minHeight: '84px', resize: 'vertical', background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-label-primary, #1f2329)', fontFamily: 'inherit', lineHeight: '20px' },
      card: { border: '1px solid var(--dsw-alias-border-1, #e8eaee)', borderRadius: '12px', padding: '12px 14px', background: 'var(--dsw-alias-bg-layer-1, #fff)' },
      cardHead: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      cardTitle: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #1f2329)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      cardBody: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #4e5969)', whiteSpace: 'pre-wrap', lineHeight: '20px', margin: '6px 0 0', wordBreak: 'break-word' },
      badge: { display: 'inline-block', padding: '2px 8px', borderRadius: '999px', fontSize: '11px', fontWeight: 600, background: 'var(--dsw-alias-fill-1, #f2f3f5)', color: 'var(--dsw-alias-label-tertiary, #8a919f)' },
      badgeOn: { display: 'inline-block', padding: '2px 8px', borderRadius: '999px', fontSize: '11px', fontWeight: 600, background: '#d3f8df', color: '#067647' },
      msg: { fontSize: '12px', color: 'var(--dsw-alias-success-6, #00b42a)' },
      msgErr: { fontSize: '12px', color: 'var(--dsw-alias-danger-5, #f53f3f)' },
      empty: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #8a919f)', padding: '12px 0' },
      row: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px', flexWrap: 'wrap' },
      small: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #8a919f)' },
    }

    /**
     * The rule editor. It owns the list, the drafts that are being edited, and
     * the add form; every write goes back to the host and refreshes the list.
     */
    function RulesPanel() {
      const [rules, setRules] = useState(null)
      const [active, setActive] = useState([])
      const [dir, setDir] = useState('')
      const [error, setError] = useState('')
      const [message, setMessage] = useState('')
      const [drafts, setDrafts] = useState({})
      const [newRule, setNewRule] = useState(null)
      const [counter, setCounter] = useState(0)

      const t = (key) => {
        const lang = (typeof document !== 'undefined' && document.documentElement.lang) || 'zh'
        const table = DICT[lang.startsWith('zh') ? 'zh' : 'en'] ?? DICT.zh
        return table[key] ?? key
      }

      const load = useCallback(async () => {
        try {
          const data = await request(API + '/rules')
          setRules(data.rules ?? [])
          setActive(data.active ?? [])
          setDir(data.dir ?? '')
          setError('')
        } catch (cause) {
          setError(String(cause?.message ?? cause))
          setRules([])
        }
      }, [])

      useEffect(() => { void load() }, [load])

      /** Save one edited rule. */
      const saveRule = async (slug) => {
        const draft = drafts[slug]
        if (draft === undefined) return
        try {
          const data = await request(API + '/rule', {
            method: 'POST',
            body: JSON.stringify({
              action: 'update',
              slug,
              title: draft.title,
              body: draft.body,
              priority: draft.priority,
            }),
          })
          setRules(data.rules ?? [])
          setDrafts(prev => { const next = { ...prev }; delete next[slug]; return next })
          setMessage(t('saved'))
          setError('')
          void load()
        } catch (cause) {
          setError(t('error') + String(cause?.message ?? cause))
        }
      }

      /** Turn one rule on or off. */
      const toggleRule = async (rule) => {
        try {
          const data = await request(API + '/rule', {
            method: 'POST',
            body: JSON.stringify({ action: rule.enabled ? 'disable' : 'enable', slug: rule.slug }),
          })
          setRules(data.rules ?? [])
          setError('')
          void load()
        } catch (cause) {
          setError(t('error') + String(cause?.message ?? cause))
        }
      }

      /** Delete one rule. */
      const deleteRule = async (rule) => {
        try {
          const data = await request(API + '/rule', {
            method: 'POST',
            body: JSON.stringify({ action: 'delete', slug: rule.slug }),
          })
          setRules(data.rules ?? [])
          setMessage('')
          setError('')
          void load()
        } catch (cause) {
          setError(t('error') + String(cause?.message ?? cause))
        }
      }

      /** Create the rule the add form holds. */
      const createRule = async () => {
        if (newRule === null) return
        try {
          const data = await request(API + '/rules', {
            method: 'POST',
            body: JSON.stringify({
              title: newRule.title,
              body: newRule.body,
              priority: newRule.priority,
            }),
          })
          setRules(data.rules ?? [])
          setNewRule(null)
          setMessage(t('saved'))
          setError('')
          void load()
        } catch (cause) {
          setError(t('error') + String(cause?.message ?? cause))
        }
      }

      /** Open one more empty add form; each press adds one more. */
      const addAnother = () => {
        setCounter(value => value + 1)
        setNewRule({ title: '', body: '', priority: 100 })
      }

      if (rules === null) return react.createElement('div', { style: s.empty }, t('loading'))

      const items = rules ?? []

      return react.createElement('div', { style: s.wrap },
        react.createElement('div', { style: s.head },
          react.createElement('div', null,
            react.createElement('div', { style: s.title }, t('title')),
            react.createElement('div', { style: s.sub }, t('hint')),
          ),
          react.createElement('button', { style: s.btnPrimary, onClick: addAnother }, t('add')),
        ),
        dir ? react.createElement('div', { style: s.small }, dir) : null,
        message ? react.createElement('div', { style: s.msg }, message) : null,
        error ? react.createElement('div', { style: s.msgErr }, t('error') + error) : null,
        items.length === 0 && newRule === null
          ? react.createElement('div', { style: s.empty }, t('empty'))
          : null,
        items.map(rule => {
          const draft = drafts[rule.slug]
          const editing = draft !== undefined
          return react.createElement('div', { key: rule.slug, style: s.card },
            react.createElement('div', { style: s.cardHead },
              react.createElement('span', { style: s.cardTitle }, rule.title),
              rule.enabled
                ? react.createElement('span', { style: s.badgeOn }, t('enable'))
                : react.createElement('span', { style: s.badge }, t('disable')),
              editing
                ? react.createElement('button', { style: s.btnPrimary, onClick: () => saveRule(rule.slug) }, t('save'))
                : react.createElement('button', { style: s.btn, onClick: () => setDrafts(prev => ({ ...prev, [rule.slug]: { title: rule.title, body: rule.body, priority: rule.priority } })) }, t('edit')),
              react.createElement('button', { style: s.btn, onClick: () => toggleRule(rule) }, rule.enabled ? t('disable') : t('enable')),
              react.createElement('button', { style: s.btnDanger, onClick: () => deleteRule(rule) }, t('remove')),
            ),
            editing
              ? react.createElement('div', null,
                  react.createElement('input', {
                    style: { ...s.input, marginTop: '10px' },
                    value: draft.title,
                    placeholder: t('titlePlaceholder'),
                    onChange: (event) => setDrafts(prev => ({ ...prev, [rule.slug]: { ...draft, title: event.target.value } })),
                  }),
                  react.createElement('textarea', {
                    style: { ...s.textarea, marginTop: '8px' },
                    value: draft.body,
                    placeholder: t('bodyPlaceholder'),
                    onChange: (event) => setDrafts(prev => ({ ...prev, [rule.slug]: { ...draft, body: event.target.value } })),
                  }),
                  react.createElement('div', { style: s.row },
                    react.createElement('span', { style: s.small }, t('priority')),
                    react.createElement('input', {
                      style: { ...s.input, width: '90px' },
                      type: 'number',
                      value: String(draft.priority ?? 100),
                      onChange: (event) => setDrafts(prev => ({ ...prev, [rule.slug]: { ...draft, priority: Number(event.target.value) } })),
                    }),
                    react.createElement('button', { style: s.btn, onClick: () => setDrafts(prev => { const next = { ...prev }; delete next[rule.slug]; return next }) }, t('cancel')),
                  ),
                )
              : react.createElement('div', { style: s.cardBody }, rule.body),
          )
        }),
        newRule !== null
          ? react.createElement('div', { style: { ...s.card, borderStyle: 'dashed' } },
              react.createElement('div', { style: s.cardHead },
                react.createElement('span', { style: s.cardTitle }, t('newRule') + ' ' + counter),
                react.createElement('button', { style: s.btn, onClick: () => setNewRule(null) }, t('cancel')),
              ),
              react.createElement('input', {
                style: { ...s.input, marginTop: '10px' },
                value: newRule.title,
                placeholder: t('titlePlaceholder'),
                onChange: (event) => setNewRule(prev => ({ ...prev, title: event.target.value })),
              }),
              react.createElement('textarea', {
                style: { ...s.textarea, marginTop: '8px' },
                value: newRule.body,
                placeholder: t('bodyPlaceholder'),
                onChange: (event) => setNewRule(prev => ({ ...prev, body: event.target.value })),
              }),
              react.createElement('div', { style: s.row },
                react.createElement('span', { style: s.small }, t('priority')),
                react.createElement('input', {
                  style: { ...s.input, width: '90px' },
                  type: 'number',
                  value: String(newRule.priority ?? 100),
                  onChange: (event) => setNewRule(prev => ({ ...prev, priority: Number(event.target.value) })),
                }),
                react.createElement('button', { style: s.btnPrimary, onClick: createRule }, t('save')),
              ),
            )
          : null,
      )
    }

    /** Register the panel into the plugin detail page's section slot. */
    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
        name: 'plugins.detail.section',
        id: 'my-rules-editor',
        order: 100,
      }, ({ subject }) => {
        const pkg = subject?.pkg
        if (subject?.kind !== 'bundle' && subject?.kind !== 'row') return null
        if (pkg !== undefined && pkg !== null && typeof pkg.name === 'string' && pkg.name !== 'dsh-my-rules') return null
        return react.createElement(RulesPanel)
      }))
    }

    return { inject, apply }
  },
})
