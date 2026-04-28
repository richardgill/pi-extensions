# sub-pi-skill

Route `/skill:` commands and skill file reads to the `sub-pi` tool when the skill frontmatter opts in.

Part of [`pi-extensions`](../../README.md).

## Behavior

- Reads skill frontmatter and checks `metadata.pi.subProcess`.
- Requires the `sub-pi` extension to be loaded (tool name: `sub-pi`).
- If `subProcess: true`, blocks in-session skill expansion and invokes the `sub-pi` tool using `subProcessContext`.
- `subProcessContext` accepts `fork` (default) or `fresh` (mapped to `sub-pi` `fork: true` / `fork: false`).
- If `subProcess` is false or omitted, keeps the skill in-session and applies `model`/`thinkingLevel` overrides to the current session.
- Optional overrides: `metadata.pi.model`, `metadata.pi.thinkingLevel`.

Example frontmatter:

```yaml
---
name: code-review
description: ...
metadata:
  pi:
    subProcess: true
    subProcessContext: fresh
    model: openai-codex/gpt-5.2
    thinkingLevel: xhigh
---
```

## Install with pi-pack

Install `pi-pack` globally:

```bash
npm install -g pi-pack
```

```bash
pi-pack install "npm:sub-pi-skill"
pi-pack install "git:github.com/<user>/pi-extensions" --extension "sub-pi-skill"
pi-pack install "~/code/pi-extensions" --extension "sub-pi-skill"
```

## Configure

```ts
import { subPiSkill } from "sub-pi-skill";

export default subPiSkill();
```

### Options

- `toolName` (default `"sub-pi"`) — the registered tool name to invoke. Match this to `SubPiOptions.name` from the `sub-pi` extension if you've customised it there.
