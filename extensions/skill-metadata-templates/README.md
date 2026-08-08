# skill-metadata-templates

Private extension that appends instructions to Pi skills based on arbitrary skill frontmatter metadata.

Part of [`pi-extensions`](../../README.md).

## Install

This extension is not published to npm. Load it directly from this repository:

```bash
pi install ./extensions/skill-metadata-templates
```

## Configure

The default config is `~/.pi/agent/skill-metadata-templates.jsonc`, or `$PI_EXTENSION_CONFIG_DIR/skill-metadata-templates.jsonc` when set.

```jsonc
{
  "rules": [
    {
      "name": "sub-process",
      "when": {
        "metadata": { "pi.subProcess": true }
      },
      "template": "Run {{name}} in a sub-process using {{metadata.pi.subProcessContext}} context."
    },
    {
      "name": "tmux",
      "when": {
        "metadata": { "execution.tmux": true }
      },
      "templateFile": "~/.pi/agent/skill-templates/tmux.md"
    },
    {
      "name": "named-window",
      "position": "top",
      "when": {
        "metadata": {
          "execution.tmux": true,
          "execution.namedWindow": true
        },
        "environment": { "PI_DELEGATE": null }
      },
      "sessionBranch": "previousTurn",
      "template": "Launch `pi --session {{runtime.sessionBranch.pathShell}} --model {{metadata.pi.model}} --thinking {{metadata.pi.thinkingLevel}} -p {{runtime.skillInvocation.shell}}`."
    }
  ]
}
```

`when.metadata` paths start at the skill's `metadata` object. Metadata conditions use strict string, number, boolean, or null equality; missing paths do not match. `when.environment` compares environment variable strings, with `null` meaning the variable must be unset. Every condition across both groups must match. Either group can be omitted.

`{{...}}` paths start at the full skill frontmatter root. Standard fields such as `{{name}}`, `{{description}}`, and `{{license}}`, arbitrary frontmatter keys, and nested paths such as `{{metadata.execution.delegatedSkill}}` are supported. Missing paths and non-scalar values produce errors.

Rules can set `sessionBranch` to `"previousTurn"`. Before rendering any matching rules, the extension creates one child session containing history through the previous completed turn. On the first turn it creates an empty parent-linked child, so the skill invocation becomes that child's first message. Matching branch-enabled rules share the child. Use the reserved `{{runtime.sessionBranch.pathShell}}` placeholder for its shell-quoted path and `{{runtime.skillInvocation.shell}}` for the shell-quoted child invocation. Do not add another layer of shell quotes around either value. Launch the child with `pi --session`, not `pi --fork`.

For `/skill:name ...`, the child invocation exactly preserves the submitted command. For skills loaded by `read`, it is `/skill:name` followed by the active textual user request, while the branch excludes that user entry and all active assistant/tool work. Branching follows the current session-tree path and preserves compaction entries and completed tool calls.

The child file is a normal persisted Pi session and is not automatically deleted. This extension only prepares and renders the session path; spawning tmux or another subprocess remains the template's orchestration responsibility. Branch-enabled rules fail without delegating when the session is ephemeral, the previous conversation is incomplete, or a queued invocation arrives while Pi is busy.

`position` accepts `top`, `bottom` (the default), or `replace`. Top rules appear before the skill body, bottom rules after it, and matching replace rules replace the original body. Top and bottom rules still surround replacement content. Rules preserve declaration order within each position and are separated by a blank line.

Each rule requires exactly one of `template` or `templateFile`. `~` expands to the home directory. Relative `templateFile` paths resolve from the directory containing `skill-metadata-templates.jsonc`.

The extension applies instructions both to `/skill:name` expansion and to loaded skill files returned by Pi's `read` tool. Skills without matching rules keep their normal behavior.

Example skill frontmatter:

```yaml
---
name: code-review
description: Review code changes.
license: MIT
metadata:
  pi:
    subProcess: true
    subProcessContext: fresh
    model: anthropic/claude-sonnet-4-5
    thinkingLevel: high
  execution:
    tmux: true
    namedWindow: true
    windowName: review
---
```
