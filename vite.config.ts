import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "node",
    include: ["extensions/*/tests/**/*.{unit,integration,e2e}.test.ts"],
  },
  lint: {
    ignorePatterns: ["node_modules/**", "coverage/**", "overlay/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    ignorePatterns: ["node_modules/**", "coverage/**", "overlay/**", "**/*.md"],
    singleQuote: false,
    sortPackageJson: true,
  },
  staged: {
    "*.{js,ts,cjs,mjs,d.cts,d.mts,jsx,tsx,json,jsonc}": "vp check --fix",
  },
  run: {
    cache: true,
  },
});
