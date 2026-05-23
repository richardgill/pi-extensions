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

Create `preset.jsonc` in your extension config folder. The folder is `PI_EXTENSION_CONFIG_DIR` when set; otherwise Pi's agent directory (usually `~/.pi/agent`, or `PI_CODING_AGENT_DIR` if Pi is pointed elsewhere).

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

## Usage

```bash
pi --preset plan
```

- `/preset` opens the selector
- `/preset implement` activates a preset directly
- `ctrl+shift+u` cycles presets
