# preset

Pi extension for named presets that can set model, thinking level, tools, and per-preset system prompt instructions.

Part of [`pi-extensions`](../../README.md).

## Install with pi-pack

```bash
pi-pack install "~/code/pi-extensions/preset-extension" --extension "preset"
```

## Configure

Edit the installed `config.ts`:

```ts
import { preset } from "preset";

export default preset({
	presets: {
		plan: {
			provider: "openai-codex",
			model: "gpt-5.2-codex",
			thinkingLevel: "high",
			tools: ["read", "bash"],
			instructions: "Planning mode. Do not edit files.",
		},
		implement: {
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			thinkingLevel: "high",
			tools: ["read", "bash", "edit", "write"],
			instructions: "Implementation mode. Make focused changes.",
		},
	},
});
```

## Usage

```bash
pi --preset plan
```

- `/preset` opens the selector
- `/preset implement` activates a preset directly
- `ctrl+shift+u` cycles presets
