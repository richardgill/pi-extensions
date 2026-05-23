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

## Install with pi

```bash
pi install npm:@richardgill/pi-sub-pi
pi install npm:@richardgill/pi-sub-pi-skill
```

or locally

```bash
pi install ~/code/pi-extensions/main/extensions/sub-pi
pi install ~/code/pi-extensions/main/extensions/sub-pi-skill
```

## Configure

You can override individual settings in `sub-pi-skill.jsonc`.

The default location is `~/.pi/agent/sub-pi-skill.jsonc`, or `$PI_EXTENSION_CONFIG_DIR/sub-pi-skill.jsonc` when set.

```jsonc
{
  "toolName": "sub-pi"
}
```

### Options

- `toolName` (default `"sub-pi"`) — the registered tool name to invoke. Match this to `name` from the `sub-pi` extension if you've customised it there.
