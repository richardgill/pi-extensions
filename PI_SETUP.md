# My Pi setup

My Pi setup is deliberately very vanilla: Pi with the extensions below. I use it with OpenAI Codex, almost always running `gpt-5.6-sol` with `high` thinking.

My Pi agent instructions are in [`AGENTS.md`](https://github.com/richardgill/nix/blob/main/built/ai-agents/pi/AGENTS.md) ([templated](https://github.com/richardgill/nix/blob/main/flake/modules/home-manager/dot-files/ai-agents/pi/AGENTS.md.hbs)).

My full Pi settings are in [`settings.json`](https://github.com/richardgill/nix/blob/main/out-of-store-config/ai-agents/pi/settings.json). This repository also has a minimal [`settings.json`](./settings.json) containing only the npm packages.

## Extensions

### Published on npm

- [`pi-background-bash`](./extensions/background-bash/README.md) - Overrides the bash tool with one that can run in the background.
- [`pi-context-commands`](./extensions/context-commands/README.md) - Registers slash commands that run commands and put the output into Pi context.
- [`pi-project-resources`](./extensions/project-resources/README.md) - Loads project instructions and skills by traversing up directories from the current working directory.
- [`pi-preset`](./extensions/preset/README.md) - Pi's preset example extension with config management.
- [`pi-up-history`](./extensions/pi-up-history/README.md) - Adds Up-arrow prompt history from saved sessions for the current working directory.
- [`pi-parrot`](./extensions/parrot/README.md) - Populates Pi's input box with the last assistant message.

### Personal defaults

[`@richardgill/pi-bits`](./packages/pi-bits/README.md) bundles:

- [`pi-footer`](./extensions/footer/README.md) - Distributed through `@richardgill/pi-bits`.
- [`pi-trust-all-projects`](./extensions/trust-all-projects/README.md) - Distributed through `@richardgill/pi-bits`.
- [`pi-notify`](./extensions/notify/README.md) - Runs a local beep command after an agent run.
- [`pi-thinking-toggle`](./extensions/thinking-toggle/README.md) - Distributed through `@richardgill/pi-bits`.

### Third party

- [`npm:@calesennett/pi-codex-fast`](https://www.npmjs.com/package/@calesennett/pi-codex-fast) - Adds OpenAI Codex `/fast` mode.
- [`npm:pi-codex-status`](https://github.com/lhl/pi-codex-status) - `/codex:status` shows OpenAI Codex usage information.
