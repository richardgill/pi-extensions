# sub-pi

<Describe what this pi extension does.>

Part of [`pi-extensions`](../../README.md).

## Install with pi-pack

Install `pi-pack` globally:

```bash
npm install -g pi-pack
```

<!-- Delete install options that do not apply before publishing. -->

```bash
pi-pack install "npm:sub-pi"
pi-pack install "git:github.com/<user>/pi-extensions" --extension "sub-pi"
pi-pack install "~/code/pi-extensions" --extension "sub-pi"
```


## Configure

```ts
import { extension } from "sub-pi";

export default extension({
  commandName: "sub-pi",
});
```
