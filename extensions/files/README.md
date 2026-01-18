# files (pi extension)

Reusable pi extension for browsing/opening files mentioned in the conversation.

## Install into a project via `.pi/extensions/`

Create a project-local extension wrapper:

```bash
mkdir -p .pi/extensions/files
```

### 1) Create `package.json` (single command)

```bash
cat > .pi/extensions/files/package.json <<'EOF'
{
  "name": "pi-project-files-extension",
  "private": true,
  "type": "module",
  "pi": { "extensions": ["./index.ts"] },
  "dependencies": {
    "files": "github:richardgill/pi-extensions#path:/extensions/files"
  }
}
EOF
```

### 2) Create `index.ts` (from scaffold)

```bash
curl -fsSL https://raw.githubusercontent.com/richardgill/pi-extensions/main/extensions/files/src/scaffold.ts \
  -o .pi/extensions/files/index.ts
```

### 3) Install

Run pnpm in the wrapper directory:

```bash
cd .pi/extensions/files
pnpm add "files@github:richardgill/pi-extensions#path:/extensions/files"
```

### 4) Run

```bash
pi
```
