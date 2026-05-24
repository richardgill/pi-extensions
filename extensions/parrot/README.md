# @richardgill/pi-parrot

Populate Pi's input box with the last assistant message.

## Usage

- Press `Alt+R`
- Or run `/parrot`

Parrot finds the latest assistant message on the current branch, keeps only visible text content, and places it in the editor for you to revise or submit.

## Installation

```bash
pi install npm:@richardgill/pi-parrot
```

## Configuration

Create `~/.pi/agent/parrot.jsonc`:

```jsonc
{
  "keyboardShortcut": "alt+r"
}
```

Set `keyboardShortcut` to `false` to disable the shortcut while keeping `/parrot`.
