---
"@richardgill/pi-speed": minor
---

- Match all Claude 5 (`claude-opus-5-*`, `claude-fable-5-*`) and GPT 6 (`gpt-6.*`) models, renaming the built-in families to `claude-5` and `gpt-6`.
- Add a top-level `defaults` key in `speed.jsonc` to override a family's default speed without copying the family, e.g. `"defaults": { "claude-5": "fast" }`.
- Add a per-speed `icon` for the footer (default `⚡`, `🐢` for built-in flex) and drop the space after it.
