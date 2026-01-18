# files (pi extension)

Reusable pi extension for browsing/opening files mentioned in the conversation.

## Install into a project via `.pi/extensions/`

Create a project-local extension wrapper:

```bash
mkdir -p ~/.pi/extensions/files
```

Install the plugin
```bash
cat > ~/.pi/extensions/files/package.json <<'EOF'
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
curl -fsSL https://raw.githubusercontent.com/richardgill/pi-extensions/main/extensions/files/src/scaffold.ts \
  -o ~/.pi/extensions/files/index.ts
(cd ~/.pi/extensions/files && npx pnpm install)
```

You can now modify `~/.pi/extensions`

### 4) Run

```bash
pi
```

### Updating later

(cd ~/.pi/extensions/files && pnpm update files)

