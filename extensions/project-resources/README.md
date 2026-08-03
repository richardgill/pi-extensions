# pi-project-resources

Pi extension for loading project context files and skill directories inherited from ancestor directories.

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
pi install npm:@richardgill/pi-project-resources
```

or locally

```bash
pi install ~/code/pi-extensions/main/extensions/project-resources
```

## Configure

You can override individual settings in `project-resources.jsonc`.

The default location is `~/.pi/agent/project-resources.jsonc`, or `$PI_EXTENSION_CONFIG_DIR/project-resources.jsonc` when set.

```jsonc
{
  "contextFilenames": ["AGENTS.local.md", "CLAUDE.local.md"],
  "contextSectionTitle": "Extra Context Files",
  "skillDirectoryPaths": [".pi/skills", ".claude/skills"]
}
```
