# @richardgill/pi-bits

A Pi package containing three independent extensions:

- `footer` - Replaces Pi's footer with model, thinking, context, and extension status information.
- `thinking-toggle` - Cycles medium, high, and xhigh thinking levels with Shift+Tab or `/toggle-thinking`.
- `trust-all-projects` - Automatically trusts and remembers every project.

> [!WARNING]
> `trust-all-projects` automatically and persistently trusts every project Pi opens. This disables the project trust prompt and allows project-local instructions, configuration, and extensions to load. Install this package only if that is the behavior you want.

## Try without installing

```sh
pi -e npm:@richardgill/pi-bits
```

## Install

```sh
pi install npm:@richardgill/pi-bits
```

Pi loads each bundled extension separately, so each can be enabled or disabled independently with `pi config`.
