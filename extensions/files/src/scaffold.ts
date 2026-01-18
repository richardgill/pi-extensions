import os from "node:os";
import { extension, mergeRanges, resolveEditorCommand } from "./extension.js";

const PLATFORM = {
	isDarwin: process.platform === "darwin",
	isLinux: process.platform === "linux",
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
				regex: /(?:^|[\s"'`([{<])((?![./~])[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.[A-Za-z0-9._-]+)/g,
				captureIndex: 1,
			},
			{
				// extensionless paths with at least one slash (e.g., scripts/build, docs/guide)
				regex: /(?:^|[\s"'`([{<])((?![./~])[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/[A-Za-z0-9_-]+)(?=$|[\s"'`<>)}\],;:#]|\.(?=$|[\s"'`<>)}\],;:#]))/g,
				captureIndex: 1,
			},
			{
				// dotfiles and dotfile paths without extensions (e.g., .env, .config/nvim/init)
				regex: /(?:^|[\s"'`([{<])(\.[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)(?=$|[\s"'`<>)}\],;:#]|\.(?=$|[\s"'`<>)}\],;:#]))/g,
				captureIndex: 1,
			},
		],

		// run tests with: `timeout 2 pi -e path/to/reveal/index.s` an look for error logging
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
		runTests: true,
	},
	directories: {
		includeInSelector: true,
		allowReveal: true,
		allowOpen: true,
		allowAddToPrompt: true,
		directorySuffix: "/",
	},
	showRanges: true,
	actionOrder: ["open", "addToPrompt"],
	commandName: "files",
	shortcuts: {
		browse: "ctrl+f",
		revealLatest: "ctrl+r",
		quickLookLatest: "ctrl+shift+r",
	},
	openCommand: (target) => {
		const ranges = mergeRanges(target.ranges);
		const args = ranges ? [target.path, ranges] : [target.path];
		return [`${os.homedir()}/Scripts/tmux-nvim-open`, ...args];
	},
	revealCommand: PLATFORM.isDarwin ? ["open"] : ["xdg-open"],
	quickLookCommand: PLATFORM.isDarwin ? ["qlmanage", "-p"] : null,
	resolveEditorCommand,
	maxEditBytes: 40 * 1024 * 1024,
	sanitize: {
		leadingTrim: /^["'`(<[]+/,
		trailingTrim: /[>"'`,;).\]]+$/,
		trailingPunctuation: /[.,;:]+$/,
		stripLineSuffix: true,
	},
});
