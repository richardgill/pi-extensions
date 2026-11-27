# pi-speed

Set per-request speed for matching Claude and OpenAI models.

```sh
pi install npm:@richardgill/pi-speed
```

To try it without saving it to your settings:

```sh
pi -e npm:@richardgill/pi-speed --speed fast
```

- `--speed off|flex|fast|ultrafast` overrides the default for every model family in this process.
- `/speed` opens a picker with only tiers configured for the current model and not blocked for its endpoint. `/speed fast` sets an override for this process, taking precedence over the flag. It survives session changes but is never saved. `/speed status` shows the selected and applied tiers.
- The footer shows the applied tier, a fallback (e.g. `⚡ultrafast→fast`), or `n/a` if the model family doesn't offer the requested tier. No footer entry means `off`.

## Configuration

Create `speed.jsonc` in `PI_EXTENSION_CONFIG_DIR`, or in Pi's agent directory (normally `~/.pi/agent`) if that variable is unset. The file is optional. These are the built-in defaults:

```jsonc
{
  "modelFamilies": {
    "claude-5": {
      "api": "anthropic-messages",
      "models": ["claude-opus-5-*", "claude-fable-5-*"],
      "default": "off",
      "speeds": [
        { "name": "fast", "patch": { "speed": "fast" }, "costMultiplier": 2 },
      ],
    },
    "gpt-6": {
      "api": "openai-responses",
      "models": ["gpt-6.*"],
      "default": "fast",
      "speeds": [
        { "name": "ultrafast", "patch": { "service_tier": "ultrafast" }, "costMultiplier": 6 },
        { "name": "fast", "patch": { "service_tier": "priority" } },
        { "name": "flex", "icon": "🐢", "patch": { "service_tier": "flex" } },
      ],
    },
  },
  "unavailable": {},
  "defaults": {},
}
```

Each top-level setting replaces its built-in value wholesale when supplied. A family matches by API and a glob on the bare model ID (no provider prefix); a registered model must not match two families. The speed names across all families, plus `off`, can be requested with `--speed` or `/speed <name>`, even if the picker doesn't list them. List tiers fastest first: if the host blocks the requested tier (use a lowercase host, including any non-default port), the extension tries lower entries, ending at `off`. A tier the family doesn't offer goes straight to standard speed. For example, set `"unavailable": { "gateway.example.com": ["ultrafast"] }` to disable that tier on a gateway. Step-down uses this config; it does not retry provider errors.

`"defaults": { "claude-5": "fast" }` overrides a family's `default` without copying the family; the value must be `off` or one of that family's speeds. Precedence: `/speed` > `--speed` > `defaults` > family `default`.

`icon` is the footer prefix (default `⚡`). `patch` replaces top-level request fields only. `costMultiplier` defaults to 1 and covers only surcharges Pi doesn't already apply. For example, Pi already prices OpenAI priority and flex. Compaction and summaries use standard speed; cache-warming requests can use the selected tier but do not receive the extension's cost correction.
