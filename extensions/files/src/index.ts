import os from "node:os";
import {
  DEFAULT_OPTIONS,
  extension,
  mergeRanges,
  resolveEditorCommand,
  type RevealOptionsInput,
} from "@richardgill/pi-files";
import { loadConfigOrDefault } from "@richardgill/pi-config";
import { z } from "zod";

const CommandSchema = z.array(z.string());
const FileActionSchema = z.enum(["reveal", "quicklook", "open", "edit", "addToPrompt"]);

const ConfigSchema = z.object({
  extract: z
    .object({
      runTests: z.boolean().default(true),
    })
    .default({ runTests: true }),
  directories: z
    .object({
      includeInSelector: z.boolean().default(DEFAULT_OPTIONS.directories.includeInSelector),
      allowReveal: z.boolean().default(DEFAULT_OPTIONS.directories.allowReveal),
      allowOpen: z.boolean().default(DEFAULT_OPTIONS.directories.allowOpen),
      allowAddToPrompt: z.boolean().default(DEFAULT_OPTIONS.directories.allowAddToPrompt),
      directorySuffix: z.string().default(DEFAULT_OPTIONS.directories.directorySuffix),
    })
    .default(DEFAULT_OPTIONS.directories),
  showRanges: z.boolean().default(DEFAULT_OPTIONS.showRanges),
  actionOrder: z.array(FileActionSchema).default(() => [...DEFAULT_OPTIONS.actionOrder]),
  commandName: z.string().default(DEFAULT_OPTIONS.commandName),
  shortcuts: z
    .object({
      browse: z.string().default(DEFAULT_OPTIONS.shortcuts.browse),
      revealLatest: z.string().default(DEFAULT_OPTIONS.shortcuts.revealLatest),
      quickLookLatest: z.string().default(DEFAULT_OPTIONS.shortcuts.quickLookLatest),
    })
    .default(DEFAULT_OPTIONS.shortcuts),
  revealCommand: CommandSchema.default(() => [...DEFAULT_OPTIONS.revealCommand]),
  quickLookCommand: CommandSchema.nullable().default(() =>
    DEFAULT_OPTIONS.quickLookCommand ? [...DEFAULT_OPTIONS.quickLookCommand] : null,
  ),
  maxEditBytes: z.number().int().positive().default(DEFAULT_OPTIONS.maxEditBytes),
});

const config = loadConfigOrDefault({
  filename: "files.jsonc",
  schema: ConfigSchema,
});

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
    runTests: config.extract.runTests,
  },
  directories: config.directories,
  showRanges: config.showRanges,
  actionOrder: config.actionOrder as RevealOptionsInput["actionOrder"],
  commandName: config.commandName,
  shortcuts: config.shortcuts as RevealOptionsInput["shortcuts"],
  openCommand: (target) => {
    const ranges = mergeRanges(target.ranges);
    const args = ranges ? [target.path, ranges] : [target.path];
    return [`${os.homedir()}/Scripts/tmux-nvim-open`, ...args];
  },
  revealCommand: config.revealCommand,
  quickLookCommand: config.quickLookCommand,
  resolveEditorCommand,
  maxEditBytes: config.maxEditBytes,
  sanitize: {
    leadingTrim: /^["'`(<[]+/,
    trailingTrim: /[>"'`,;).\]]+$/,
    trailingPunctuation: /[.,;:]+$/,
    stripLineSuffix: true,
  },
});
