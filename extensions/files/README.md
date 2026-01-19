# files pi extension

pi extension for browsing/opening files mentioned in the conversation.

## Install into a project via `.pi/extensions/`

Create a project-local extension wrapper:

```bash
mkdir -p ~/.pi/agent/extensions/files
```

Install the plugin
```bash
cat > ~/.pi/agent/extensions/files/package.json <<'EOF'
{
  "name": "extension-files",
  "private": true,
  "type": "module",
  "dependencies": {
    "files": "github:richardgill/pi-extensions#path:/extensions/files"
  },
  "devDependencies": {
    "@types/node": "^22.13.1"
  }
}

EOF
curl -fsSL "https://raw.githubusercontent.com/richardgill/pi-extensions/main/extensions/files/src/scaffold.ts?cache-bust=1" \
  -o ~/.pi/agent/extensions/files/index.ts
(cd ~/.pi/agent/extensions/files && npx pnpm install)
```

You can now modify `~/.pi/agent/extensions/files/index.ts` to configure the extension

Start a fresh `pi`.

### Updating later

```bash
(cd ~/.pi/agent/extensions/files && npx pnpm update files)
```
