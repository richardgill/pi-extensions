# pi-project-resources

Pi extension for discovering project context files and skill directories from the filesystem root down to the current working directory.

By default it loads these context files:

- `AGENTS.local.md`
- `CLAUDE.local.md`

It shows loaded context files at startup and appends their contents to the system prompt. It also contributes existing skill directories through Pi's `resources_discover` event:

- `.pi/skills`
- `.claude/skills`

Project skill directories are contributed only when Pi trusts the project.

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
