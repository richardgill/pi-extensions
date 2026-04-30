# @richardgill/pi-extra-context-files

pi extension for loading extra context files into the system prompt.

By default it loads these files while walking from the filesystem root to the current working directory:

- `AGENTS.local.md`
- `CLAUDE.local.md`

When files are found, the extension shows them at startup and appends their contents to the system prompt.

Part of [`pi-extensions`](../../README.md).

## Install with pi

```bash
pi install git:github.com/richardgill/pi-extensions
```

or locally

```bash
pi install ~/code/pi-extensions/main/extensions/extra-context-files
```

## Configure

Create `extra-context-files.jsonc` in your pi agent config folder:

```jsonc
{
  "filenames": ["AGENTS.local.md", "CLAUDE.local.md"],
  "sectionTitle": "Extra Context Files"
}
```
