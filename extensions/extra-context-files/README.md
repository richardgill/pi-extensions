# pi-extra-context-files

Pi extension for loading extra context files and skill directories inherited from ancestor directories.

By default it loads these files while walking from the filesystem root to the current working directory:

- `AGENTS.local.md`
- `CLAUDE.local.md`

It also discovers these skill directories along the same path for trusted projects:

- `.pi/skills`
- `.claude/skills`

When context files are found, the extension shows them at startup and appends their contents to the system prompt. Existing skill directories are contributed through Pi's `resources_discover` event.

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

You can override individual settings in `extra-context-files.jsonc`.

The default location is `~/.pi/agent/extra-context-files.jsonc`, or `$PI_EXTENSION_CONFIG_DIR/extra-context-files.jsonc` when set.

```jsonc
{
  "filenames": ["AGENTS.local.md", "CLAUDE.local.md"],
  "sectionTitle": "Extra Context Files",
  "skillDirectoryPaths": [".pi/skills", ".claude/skills"]
}
```
