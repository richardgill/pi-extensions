# preset

Pi extension for named presets that can set model, thinking level, tools, and per-preset system prompt instructions.

Part of [`pi-extensions`](../../README.md).

## Install with pi

```bash
pi install npm:@richardgill/pi-preset
```

or locally

```bash
pi install ~/code/pi-extensions/main/extensions/preset
```

## Configure

You can override individual settings in `preset.jsonc`.

The default location is `~/.pi/agent/preset.jsonc`, or `$PI_EXTENSION_CONFIG_DIR/preset.jsonc` when set.

```jsonc
{
  "presets": {
    "plan": {
      "provider": "openai-codex",
      "model": "gpt-5.2-codex",
      "thinkingLevel": "high",
      "tools": ["read", "bash"],
      "instructions": "Planning mode. Do not edit files."
    },
    "implement": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-5",
      "thinkingLevel": "high",
      "tools": ["read", "bash", "edit", "write"],
      "instructions": "Implementation mode. Make focused changes."
    }
  }
}
```

### Instructions from a markdown file

Instead of inline `instructions`, a preset can point at a markdown file with `instructionsFile`:

```jsonc
{
  "presets": {
    "plan": {
      "provider": "openai-codex",
      "model": "gpt-5.2-codex",
      "tools": ["read", "bash"],
      "instructionsFile": "prompts/plan.md"
    }
  }
}
```

- `instructionsFile` is resolved relative to the config directory (`~/.pi/agent`, or `$PI_EXTENSION_CONFIG_DIR` when set). Absolute paths and a leading `~` are supported.
- The file is re-read on every turn, so edits take effect without restarting pi. If it cannot be read, pi shows a warning and the preset's inline `instructions` (if any) are used instead.
- `instructions` and `instructionsFile` can be combined. When both are set, the file contents come first and the inline `instructions` text is appended after them, separated by a blank line.

## Usage

```bash
pi --preset plan
```

- `/preset` opens the selector
- `/preset implement` activates a preset directly
- `ctrl+shift+u` cycles presets
