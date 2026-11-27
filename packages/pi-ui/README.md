# pi-ui

Shared UI helpers for Pi extensions. Install `@richardgill/pi-ui` as a dependency of your extension.

```ts
import { selectCurrent } from "@richardgill/pi-ui";

const flavor = await selectCurrent(ctx, {
  title: "Choose an ice cream flavor",
  options: ["Vanilla", "Chocolate", "Strawberry"],
  current: "Chocolate",
});
```

The TUI picker opens on the current option and marks it with a ✓:

```text
──────────────────────────────────────
Choose an ice cream flavor
  Vanilla
→ Chocolate ✓
  Strawberry
↑↓ navigate • enter select • esc cancel
──────────────────────────────────────
```

If the current option isn't listed, the cursor starts on the first option with nothing marked. In RPC mode, the picker uses Pi's standard selection dialog with the same current marker.

The result is the original option string, or `undefined` if cancelled, no options were supplied, or Pi is running without a UI.
