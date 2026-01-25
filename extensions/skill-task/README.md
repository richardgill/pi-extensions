# skill-task pi extension

Route `/skill:` commands and skill file reads to the task tool when the skill frontmatter opts in.

## Behavior

- Reads skill frontmatter and checks `metadata.pi.forkContext`.
- Requires the task-tool extension to be loaded (tool name: task).
- If `forkContext: true`, blocks in-session skill expansion and invokes the task tool.
- If `forkContext` is false or omitted, keeps the skill in-session and applies `model`/`thinkingLevel` overrides to the current session.
- Optional overrides: `metadata.pi.model`, `metadata.pi.thinkingLevel`.

Example frontmatter:

```yaml
---
name: code-review
description: ...
metadata:
  pi:
    forkContext: true
    model: openai-codex/gpt-5.2
    thinkingLevel: xhigh
---
```

## Install into a project via `~/.pi/agent/extensions/`

Create a project-local extension wrapper:

```bash
mkdir -p ~/.pi/agent/extensions/skill-task
```

Install the plugin:

```bash
cat > ~/.pi/agent/extensions/skill-task/package.json <<'EOF'
{
  "name": "extension-skill-task",
  "private": true,
  "type": "module",
  "dependencies": {
    "skill-task": "github:richardgill/pi-extensions#path:/extensions/skill-task"
  },
  "devDependencies": {
    "@types/node": "^22.13.1"
  }
}
EOF

curl -fsSL "https://raw.githubusercontent.com/richardgill/pi-extensions/main/extensions/skill-task/src/scaffold.ts?cache-bust=1" \
  -o ~/.pi/agent/extensions/skill-task/index.ts

(cd ~/.pi/agent/extensions/skill-task && npx pnpm install)
```

Start a fresh `pi`.

### Updating later

```bash
(cd ~/.pi/agent/extensions/skill-task && npx pnpm update skill-task)
```
