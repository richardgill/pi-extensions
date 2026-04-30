# Contributing

`CONTRIBUTING.md` is the conventional root-level file for contributor instructions. GitHub detects this filename and links it from issue and pull request flows.

## Setup

```bash
pnpm install
```

## Local checks

Run the same checks expected before a PR:

```bash
pnpm run local-ci
```

## Changesets

Use changesets for normal package changes that should be released:

```bash
pnpm changeset
```

Then choose the changed package, select the semver bump, and write a short release note.

## Publishing an npm package for the first time manually

Use this only for the first manual publish of a new public package. After the package exists on npm, prefer the changesets release flow.

1. Confirm the workspace package is publishable:
   - `package.json` has the correct `name`, `version`, `repository`, `files`, and `exports`.
   - The package does not have `"private": true`.
   - Scoped public packages use `--access public` when publishing.
2. Confirm npm auth and package availability:

   ```bash
   npm whoami
   npm view @richardgill/<package-name> version
   ```

   If `npm view` returns a 404, the package name is available to publish.

3. Dry-run the publish from the package directory:

   ```bash
   cd extensions/<package-name>
   pnpm publish --access public --dry-run
   ```

4. Publish for real:

   ```bash
   pnpm publish --access public
   ```

5. Verify the package is visible:

   ```bash
   npm view @richardgill/<package-name> version
   ```

6. Add npm trusted publishing for future automated releases:
   - Open `https://www.npmjs.com/package/@richardgill/<package-name>/access`, then go to **Publishing access**.
   - Add a GitHub Actions trusted publisher.
   - Repository: `richardgill/pi-extensions`.
   - Workflow file: `release.yml`.
   - Environment: leave blank unless the GitHub Actions workflow starts using one.
   - Do not add an npm token for this repo unless trusted publishing is unavailable.

## Normal release flow

For packages that already exist on npm:

```bash
pnpm changeset
pnpm changeset-version
pnpm changeset-publish
```
