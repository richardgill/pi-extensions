---
"@richardgill/pi-preset": minor
---

Add `instructionsFile` to presets so instructions can come from a markdown file instead of inline text. Relative paths resolve against the preset config directory, the file is re-read each turn, and inline `instructions` are appended after the file contents when both are set.
