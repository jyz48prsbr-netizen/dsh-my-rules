# dsh-my-rules

个人规则文件插件：一条规则一个 Markdown 文件，随时自由编辑、增删、停用；生效的规则会注入到每个会话的系统提示词里。

## 规则文件

默认目录 `~/.dsh/my-rules/`（可在插件行配置里改 `dir`）。每个 `.md` 文件是一条规则：

```markdown
---
title: 规则标题
enabled: true
priority: 100
---

规则正文：模型必须遵守的约定。
```

- `enabled: false` 表示停用（保留文件，不注入）
- `priority` 越大越靠前
- 正文即注入内容

## 三种管理方式

1. **直接编辑文件**：用任何文本编辑器改上面的目录，保存即生效。
2. **斜杠命令**：`/myrules` 查看；`/myrules add 标题｜正文` 新增；`/myrules del 规则号` 删除。
3. **让 Agent 代办**：对 Agent 说「把这条记成规则」，它会调用 `my_rules` 工具。

## 生效方式

启用中的规则通过宿主 `systemPrompt` 服务注册为一个系统提示词段（`my-rules:user-rules`），
每个 Agent、每个会话都看得到，不占用对话轮次，也不进入历史消息。
每次组装提示词时重新读取文件，所以改动无需重启。
