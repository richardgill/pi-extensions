# @richardgill/pi-parrot

Populate Pi's input box with the last assistant message.

## Usage

- Press `Alt+R`
- Or run `/parrot`

Parrot finds the latest assistant message on the current branch, keeps only visible text content, and places it in the Pi input box for you to revise or submit.

## Installation

```bash
pi install npm:@richardgill/pi-parrot
```

## Configuration

You can override individual settings in `parrot.jsonc`.

The default location is `~/.pi/agent/parrot.jsonc`, or `$PI_EXTENSION_CONFIG_DIR/parrot.jsonc` when set.

Default config settings:

```jsonc
{
  // Keyboard shortcut registered for Parrot.
  // Set to false to disable the shortcut while keeping /parrot.
  "keyboardShortcut": "alt+r", // "alt+r" (default) | false | any Pi key id

  // Open the last assistant message in $VISUAL or $EDITOR before placing/sending it.
  "openExternalEditor": false, // true | false (default)

  // Submit the text after the external editor exits.
  // Only applies when openExternalEditor is true.
  "sendAfterEditorClose": false // true | false (default)
}
```
