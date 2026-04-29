import os from "node:os";
import {
  extension,
  mergeRanges,
  resolveEditorCommand,
  type RevealOptionsInput,
} from "@richardgill/pi-files";
import { loadConfigOrDefault } from "@richardgill/pi-config";
import { z } from "zod";

const PLATFORM = {
  isDarwin: process.platform === "darwin",
  isLinux: process.platform === "linux",
};

const CommandSchema = z.array(z.string());
const FileActionSchema = z.enum(["reveal", "quicklook", "open", "edit", "addToPrompt"]);

const ConfigSchema = z.object({
  extract: z
    .object({
      runTests: z.boolean().optional(),
    })
    .optional(),
  directories: z
    .object({
      includeInSelector: z.boolean().optional(),
      allowReveal: z.boolean().optional(),
      allowOpen: z.boolean().optional(),
      allowAddToPrompt: z.boolean().optional(),
      directorySuffix: z.string().optional(),
    })
    .optional(),
  showRanges: z.boolean().optional(),
  actionOrder: z.array(FileActionSchema).optional(),
  commandName: z.string().optional(),
  shortcuts: z
    .object({
      browse: z.string().optional(),
      revealLatest: z.string().optional(),
      quickLookLatest: z.string().optional(),
    })
    .optional(),
  revealCommand: CommandSchema.optional(),
  quickLookCommand: CommandSchema.nullable().optional(),
  maxEditBytes: z.number().int().positive().optional(),
});

const config = loadConfigOrDefault({ filename: "files.jsonc", schema: ConfigSchema });

const directories = {
  includeInSelector: true,
  allowReveal: true,
  allowOpen: true,
  allowAddToPrompt: true,
  directorySuffix: "/",
  ...config.directories,
};

const shortcuts = {
  browse: "ctrl+f",
  revealLatest: "ctrl+r",
  quickLookLatest: "ctrl+shift+r",
  ...config.shortcuts,
};

export default extension({
  extract: {
    patterns: [
      // <file name="src/index.ts">
      { regex: /<file\s+name=["']([^"']+)["']>/g, captureIndex: 1 },
      // file:///tmp/project/file.txt
      { regex: /file:\/\/[^\s"'<>]+/g, captureIndex: 0 },
      // /var/log/syslog or ~/code/project
      { regex: /(?:^|[\s"'`([{<])((?:~|\/)[^\s"'`<>)}\]]+)/g, captureIndex: 1 },
      // ./file.txt or ./dir/file.txt
      { regex: /(?:^|[\s"'`([{<])(\.\/[^\s"'`<>)}\]]+)/g, captureIndex: 1 },
      // file.txt or dir/file.txt
      {
        regex:
          /(?:^|[\s"'`([{<])((?![./~])[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.[A-Za-z0-9._-]+)/g,
        captureIndex: 1,
      },
      {
        // extensionless paths with at least one slash (e.g., scripts/build, docs/guide)
        regex:
          /(?:^|[\s"'`([{<])((?![./~])[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/[A-Za-z0-9_-]+)(?=$|[\s"'`<>)}\],;:#]|\.(?=$|[\s"'`<>)}\],;:#]))/g,
        captureIndex: 1,
      },
      {
        // dotfiles and dotfile paths without extensions (e.g., .env, .config/nvim/init)
        regex:
          /(?:^|[\s"'`([{<])(\.[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)(?=$|[\s"'`<>)}\],;:#]|\.(?=$|[\s"'`<>)}\],;:#]))/g,
        captureIndex: 1,
      },
    ],

    testCases: [
      {
        text: "See file:///tmp/project/file.txt for details",
        expected: [{ path: "file:///tmp/project/file.txt" }],
      },
      {
        text: '<file name="a.ts"> and <file name="b.ts">',
        expected: [{ path: "a.ts" }, { path: "b.ts" }],
      },
      {
        text: "Paths: /var/log/syslog ~/code/project",
        expected: [{ path: "/var/log/syslog" }, { path: "~/code/project" }],
      },
      {
        text: "./readme.txt ./docs/setup.md",
        expected: [{ path: "./readme.txt" }, { path: "./docs/setup.md" }],
      },
      {
        text: "Relative paths: notes.txt:7 other/notes.txt:9-10",
        expected: [
          { path: "notes.txt", ranges: "7" },
          { path: "other/notes.txt", ranges: "9-10" },
        ],
      },
      {
        text: "Extensionless paths: scripts/build docs/guide .env .config/nvim/init",
        expected: [
          { path: "scripts/build" },
          { path: "docs/guide" },
          { path: ".env" },
          { path: ".config/nvim/init" },
        ],
      },
      { text: "README.md", expected: [{ path: "README.md" }] },
      { text: ".env", expected: [{ path: ".env" }] },
    ],
    runTests: config.extract?.runTests ?? true,
  },
  directories,
  showRanges: config.showRanges ?? true,
  actionOrder: (config.actionOrder ?? ["open", "addToPrompt"]) as RevealOptionsInput["actionOrder"],
  commandName: config.commandName ?? "files",
  shortcuts: shortcuts as RevealOptionsInput["shortcuts"],
  openCommand: (target) => {
    const ranges = mergeRanges(target.ranges);
    const args = ranges ? [target.path, ranges] : [target.path];
    return [`${os.homedir()}/Scripts/tmux-nvim-open`, ...args];
  },
  revealCommand: config.revealCommand ?? (PLATFORM.isDarwin ? ["open"] : ["xdg-open"]),
  quickLookCommand:
    config.quickLookCommand === undefined
      ? PLATFORM.isDarwin
        ? ["qlmanage", "-p"]
        : null
      : config.quickLookCommand,
  resolveEditorCommand,
  maxEditBytes: config.maxEditBytes ?? 40 * 1024 * 1024,
  sanitize: {
    leadingTrim: /^["'`(<[]+/,
    trailingTrim: /[>"'`,;).\]]+$/,
    trailingPunctuation: /[.,;:]+$/,
    stripLineSuffix: true,
  },
});
