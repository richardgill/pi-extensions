# @richardgill/pi-files

pi extension for browsing, opening, revealing, and editing files mentioned in the conversation.

Adds a `files` slash command and three default shortcuts:

- `ctrl+f` — fuzzy-pick a file referenced in the session
- `ctrl+r` — reveal the latest file reference in Finder / file manager
- `ctrl+shift+r` — Quick Look the latest file reference (macOS)

Part of [`pi-extensions`](../../README.md).

## Install with pi

```bash
pi install git:github.com/richardgill/pi-extensions
```


## Configure

Create `files.jsonc` in your extension config folder. The folder is `PI_EXTENSION_CONFIG_DIR` when set; otherwise Pi's agent directory (usually `~/.pi/agent`, or `PI_CODING_AGENT_DIR` if Pi is pointed elsewhere).

```jsonc
{
  "commandName": "files",
  "showRanges": true,
  "actionOrder": ["open", "addToPrompt"],
  "shortcuts": {
    "browse": "ctrl+f",
    "revealLatest": "ctrl+r",
    "quickLookLatest": "ctrl+shift+r"
  }
}
```
