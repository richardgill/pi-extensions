# files

pi extension for browsing, opening, revealing, and editing files mentioned in the conversation.

Adds a `files` slash command and three default shortcuts:

- `ctrl+f` — fuzzy-pick a file referenced in the session
- `ctrl+r` — reveal the latest file reference in Finder / file manager
- `ctrl+shift+r` — Quick Look the latest file reference (macOS)

Part of [`pi-extensions`](../../README.md).

## Install with pi-pack

Install `pi-pack` globally:

```bash
npm install -g pi-pack
```

<!-- Delete install options that do not apply before publishing. -->

```bash
pi-pack install "npm:files"
pi-pack install "git:github.com/<user>/pi-extensions" --extension "files"
pi-pack install "~/code/pi-extensions" --extension "files"
```


## Configure

```ts
import { extension } from "files";

export default extension({
  commandName: "files",
});
```
