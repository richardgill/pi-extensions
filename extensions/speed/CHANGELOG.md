# @richardgill/pi-speed

## 0.1.2

### Patch Changes

- [#85](https://github.com/richardgill/pi-extensions/pull/85) [`3c1975e`](https://github.com/richardgill/pi-extensions/commit/3c1975edf5a49a692e81cc284ff13aa1224405ca) Thanks [@richardgill](https://github.com/richardgill)! - Add a shared picker that opens on and marks the current selection. Use it for `/speed` and `/preset`.

- Updated dependencies [[`3c1975e`](https://github.com/richardgill/pi-extensions/commit/3c1975edf5a49a692e81cc284ff13aa1224405ca)]:
  - @richardgill/pi-ui@0.0.1

## 0.1.1

### Patch Changes

- [`a1d2e88`](https://github.com/richardgill/pi-extensions/commit/a1d2e88eff30adb17947332b7d8915ebc203e157) Thanks [@richardgill](https://github.com/richardgill)! - Show built-in footer icons for `⚡` fast (Claude 5 and GPT 6) and `🚀` ultrafast (GPT 6), alongside the existing `🐢` flex.

## 0.1.0

### Minor Changes

- [#82](https://github.com/richardgill/pi-extensions/pull/82) [`24d334b`](https://github.com/richardgill/pi-extensions/commit/24d334b39d3c8d76e8c2745ded0fcdc19ed926ca) Thanks [@richardgill](https://github.com/richardgill)! - - Match all Claude 5 (`claude-opus-5-*`, `claude-fable-5-*`) and GPT 6 (`gpt-6.*`) models, renaming the built-in families to `claude-5` and `gpt-6`. GPT 6 now defaults to `off` instead of `fast`.
  - Add a top-level `defaults` key in `speed.jsonc` to override a family's default speed without copying the family, e.g. `"defaults": { "claude-5": "fast" }`.
  - Add an optional per-speed footer `icon` (`🐢` for built-in flex); other tiers show no icon by default. Top-level `iconSeparator` (default `""`) sets the text between icon and tier name.

## 0.0.2

### Patch Changes

- [`18257ca`](https://github.com/richardgill/pi-extensions/commit/18257ca7342932e167f467a3f9beebe3992ac03d) Thanks [@richardgill](https://github.com/richardgill)! - Enable automated npm releases for pi-speed. No runtime changes.
