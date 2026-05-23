# @richardgill/pi-extra-context-files

pi extension for loading extra context files into the system prompt.

By default it loads these files while walking from the filesystem root to the current working directory:

- `AGENTS.local.md`
- `CLAUDE.local.md`

When files are found, the extension shows them at startup and appends their contents to the system prompt.

Part of [`pi-extensions`](../../README.md).

## Install with pi

```bash
pi install npm:@richardgill/pi-extra-context-files
```

or locally

```bash
pi install ~/code/pi-extensions/main/extensions/extra-context-files
```

## Configure

Create `extra-context-files.jsonc` in your extension config folder. The folder is `PI_EXTENSION_CONFIG_DIR` when set; otherwise Pi's agent directory (usually `~/.pi/agent`, or `PI_CODING_AGENT_DIR` if Pi is pointed elsewhere).

```jsonc
{
  "filenames": ["AGENTS.local.md", "CLAUDE.local.md"],
  "sectionTitle": "Extra Context Files"
}
```
