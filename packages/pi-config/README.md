# @richardgill/pi-config

JSONC config loading helpers for Pi extensions.

## Usage

```ts
import { loadConfigOrDefault, templatedString } from "@richardgill/pi-config";
import { z } from "zod";

const schema = z.object({
  maxTimeoutSeconds: z.number().int().positive(),
  prompt: templatedString({ variables: ["maxTimeoutSeconds"] }).optional(),
});

export const config = loadConfigOrDefault({
  filename: "my-extension.jsonc",
  schema,
  defaults: {
    maxTimeoutSeconds: 60,
    prompt: "Max timeout is {{maxTimeoutSeconds}}s.",
  },
});
```

## User config files

By default, config files are loaded from Pi's agent directory, usually `~/.pi/agent`.

For the example above, the end user can create:

```jsonc
// ~/.pi/agent/my-extension.jsonc
{
  // JSONC comments and trailing commas are allowed.
  "maxTimeoutSeconds": 30,
  "prompt": "Use at most {{maxTimeoutSeconds}} seconds."
}
```

The loader merges this file over the extension defaults, renders tagged string templates, then validates the final result with Zod.

If the file is missing, `loadConfigOrDefault` uses the defaults.

## Templates

Only fields declared with `templatedString(...)` are rendered.

```ts
prompt: templatedString({
  variables: ["defaultTimeoutSeconds", "maxTimeoutSeconds"],
  missing: "throw",
})
```

`renderTemplates` defaults to `true`; set `renderTemplates: false` to opt out.

Template variables must be declared on the field, exist in the loaded config, and resolve to a string, number, or boolean.

## API

- `loadConfigOrDefault(...)`
- `resolveOptions(...)`
- `templatedString(...)`
