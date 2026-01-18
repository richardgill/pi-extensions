import { spawnSync } from "node:child_process";
import {
	existsSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	getEditorKeybindings,
	Input,
	type KeyId,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	type TUI,
} from "@mariozechner/pi-tui";

type ContentBlock = {
	type?: string;
	text?: string;
	arguments?: Record<string, unknown>;
};

type FileReference = {
	path: string;
	display: string;
	exists: boolean;
	isDirectory: boolean;
	ranges?: string;
};

type NormalizedReference = { path: string; ranges?: string };

type ExtractedReference = { path: string; ranges?: string };

type CommandSpec = readonly string[];

type ExtractPattern = { regex: RegExp; captureIndex: number };

type ExtractPatternTest = { text: string; expected: ExtractedReference[] };

type FileAction = "reveal" | "quicklook" | "open" | "edit" | "addToPrompt";

type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends (...args: never[]) => unknown
		? T[K]
		: T[K] extends RegExp
			? RegExp
			: T[K] extends readonly unknown[]
				? T[K]
				: T[K] extends object
					? DeepPartial<T[K]>
					: T[K];
};

export type RevealOptions = {
	extract: {
		patterns: ExtractPattern[];
		testCases: ExtractPatternTest[];
		runTests: boolean;
	};
	directories: {
		includeInSelector: boolean;
		allowReveal: boolean;
		allowOpen: boolean;
		allowAddToPrompt: boolean;
		directorySuffix: string;
	};
	showRanges: boolean;
	actionOrder: FileAction[];
	commandName: string;
	shortcuts: {
		browse: KeyId;
		revealLatest: KeyId;
		quickLookLatest: KeyId;
	};
	openCommand: (target: FileReference) => CommandSpec;
	revealCommand: CommandSpec;
	quickLookCommand: CommandSpec | null;
	resolveEditorCommand: (env: NodeJS.ProcessEnv) => CommandSpec | undefined;
	maxEditBytes: number;
	sanitize: {
		leadingTrim: RegExp;
		trailingTrim: RegExp;
		trailingPunctuation: RegExp;
		stripLineSuffix: boolean;
	};
};

export type RevealOptionsInput = DeepPartial<RevealOptions>;

const PLATFORM = {
	isDarwin: process.platform === "darwin",
	isLinux: process.platform === "linux",
};

const parseCommandArgs = (argsString: string): string[] => {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i += 1) {
		const char = argsString[i];

		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (char === " " || char === "\t") {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}

	if (current) {
		args.push(current);
	}

	return args;
};

export const resolveEditorCommand = (
	env: NodeJS.ProcessEnv,
): CommandSpec | undefined => {
	const value = env.VISUAL ?? env.EDITOR;
	if (!value) {
		return undefined;
	}

	const parsed = parseCommandArgs(value);
	return parsed.length > 0 ? parsed : undefined;
};

// <file name="src/index.ts">
export const fileTagExtractPattern: ExtractPattern = {
	regex: /<file\s+name=["']([^"']+)["']>/g,
	captureIndex: 1,
};

// file:///tmp/project/file.txt
export const fileUrlExtractPattern: ExtractPattern = {
	regex: /file:\/\/[^\s"'<>]+/g,
	captureIndex: 0,
};

// /var/log/syslog or ~/code/project
export const tildeOrAbsolutePathExtractPattern: ExtractPattern = {
	regex: /(?:^|[\s"'`([{<])((?:~|\/)[^\s"'`<>)}\]]+)/g,
	captureIndex: 1,
};

// ./file.txt or ./dir/file.txt
export const dotSlashPathExtractPattern: ExtractPattern = {
	regex: /(?:^|[\s"'`([{<])(\.\/[^\s"'`<>)}\]]+)/g,
	captureIndex: 1,
};

// file.txt or dir/file.txt
export const relativePathWithExtensionExtractPattern: ExtractPattern = {
	regex:
		/(?:^|[\s"'`([{<])((?![./~])[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.[A-Za-z0-9._-]+)/g,
	captureIndex: 1,
};

// scripts/build or docs/guide
export const relativePathWithoutExtensionExtractPattern: ExtractPattern = {
	regex:
		/(?:^|[\s"'`([{<])((?![./~])[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/[A-Za-z0-9_-]+)(?=$|[\s"'`<>)}\],;:#]|\.(?=$|[\s"'`<>)}\],;:#]))/g,
	captureIndex: 1,
};

// .env or .config/nvim/init
export const dotPathExtractPattern: ExtractPattern = {
	regex:
		/(?:^|[\s"'`([{<])(\.[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)(?=$|[\s"'`<>)}\],;:#]|\.(?=$|[\s"'`<>)}\],;:#]))/g,
	captureIndex: 1,
};

export const DEFAULT_EXTRACT_PATTERNS: ExtractPattern[] = [
	fileTagExtractPattern,
	fileUrlExtractPattern,
	tildeOrAbsolutePathExtractPattern,
	dotSlashPathExtractPattern,
	relativePathWithExtensionExtractPattern,
	relativePathWithoutExtensionExtractPattern,
	dotPathExtractPattern,
];

const DEFAULT_OPTIONS: RevealOptions = {
	extract: {
		patterns: DEFAULT_EXTRACT_PATTERNS,
		testCases: [],
		runTests: false,
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
	openCommand: (target: FileReference): CommandSpec => {
		const command = PLATFORM.isDarwin ? "open" : "xdg-open";
		return [command, target.path];
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
};

const resolveOptions = (input: RevealOptionsInput = {}): RevealOptions => {
	const extract = input.extract;
	const directories = input.directories;
	const shortcuts = input.shortcuts;
	const sanitize = input.sanitize;

	return {
		extract: {
			patterns: extract?.patterns ?? DEFAULT_OPTIONS.extract.patterns,
			testCases: extract?.testCases ?? DEFAULT_OPTIONS.extract.testCases,
			runTests: extract?.runTests ?? DEFAULT_OPTIONS.extract.runTests,
		},
		directories: {
			includeInSelector:
				directories?.includeInSelector ??
				DEFAULT_OPTIONS.directories.includeInSelector,
			allowReveal:
				directories?.allowReveal ?? DEFAULT_OPTIONS.directories.allowReveal,
			allowOpen:
				directories?.allowOpen ?? DEFAULT_OPTIONS.directories.allowOpen,
			allowAddToPrompt:
				directories?.allowAddToPrompt ??
				DEFAULT_OPTIONS.directories.allowAddToPrompt,
			directorySuffix:
				directories?.directorySuffix ??
				DEFAULT_OPTIONS.directories.directorySuffix,
		},
		showRanges: input.showRanges ?? DEFAULT_OPTIONS.showRanges,
		actionOrder: input.actionOrder ?? DEFAULT_OPTIONS.actionOrder,
		commandName: input.commandName ?? DEFAULT_OPTIONS.commandName,
		shortcuts: {
			browse: shortcuts?.browse ?? DEFAULT_OPTIONS.shortcuts.browse,
			revealLatest:
				shortcuts?.revealLatest ?? DEFAULT_OPTIONS.shortcuts.revealLatest,
			quickLookLatest:
				shortcuts?.quickLookLatest ?? DEFAULT_OPTIONS.shortcuts.quickLookLatest,
		},
		openCommand: input.openCommand ?? DEFAULT_OPTIONS.openCommand,
		revealCommand: input.revealCommand ?? DEFAULT_OPTIONS.revealCommand,
		quickLookCommand:
			input.quickLookCommand !== undefined
				? input.quickLookCommand
				: DEFAULT_OPTIONS.quickLookCommand,
		resolveEditorCommand:
			input.resolveEditorCommand ?? DEFAULT_OPTIONS.resolveEditorCommand,
		maxEditBytes: input.maxEditBytes ?? DEFAULT_OPTIONS.maxEditBytes,
		sanitize: {
			leadingTrim:
				sanitize?.leadingTrim ?? DEFAULT_OPTIONS.sanitize.leadingTrim,
			trailingTrim:
				sanitize?.trailingTrim ?? DEFAULT_OPTIONS.sanitize.trailingTrim,
			trailingPunctuation:
				sanitize?.trailingPunctuation ??
				DEFAULT_OPTIONS.sanitize.trailingPunctuation,
			stripLineSuffix:
				sanitize?.stripLineSuffix ?? DEFAULT_OPTIONS.sanitize.stripLineSuffix,
		},
	};
};

const parseRangePart = (
	part: string,
): { start: number; end: number } | null => {
	if (!part) {
		return null;
	}
	const cleaned = part.replace(/^L/i, "").replace(/L$/i, "");
	const dashIndex = cleaned.indexOf("-");
	if (dashIndex >= 0) {
		const start = Number.parseInt(cleaned.slice(0, dashIndex), 10);
		const end = Number.parseInt(cleaned.slice(dashIndex + 1), 10);
		if (
			Number.isFinite(start) &&
			Number.isFinite(end) &&
			start > 0 &&
			end >= start
		) {
			return { start, end };
		}
		return null;
	}

	const value = Number.parseInt(cleaned, 10);
	if (Number.isFinite(value) && value > 0) {
		return { start: value, end: value };
	}

	return null;
};

export const mergeRanges = (
	existing?: string,
	incoming?: string,
): string | undefined => {
	const parts = [
		...(existing ?? "").split(","),
		...(incoming ?? "").split(","),
	].filter(Boolean);
	if (parts.length === 0) {
		return undefined;
	}

	const normalized: { start: number; end: number }[] = [];
	for (const raw of parts) {
		const parsed = parseRangePart(raw.replace(/L/gi, ""));
		if (parsed) {
			normalized.push(parsed);
		}
	}

	normalized.sort((a, b) => a.start - b.start || a.end - b.end);

	const merged: { start: number; end: number }[] = [];
	for (const range of normalized) {
		const last = merged[merged.length - 1];
		if (!last || range.start > last.end + 1) {
			merged.push({ ...range });
		} else {
			last.end = Math.max(last.end, range.end);
		}
	}

	return merged
		.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`))
		.join(",");
};

const extractFileReferencesFromText = (
	text: string,
	options: RevealOptions,
): string[] => {
	const refs: string[] = [];
	const seen = new Set<string>();

	for (const { regex, captureIndex } of options.extract.patterns) {
		for (const match of text.matchAll(regex)) {
			const value = match[captureIndex];
			const matchIndex = match.index ?? -1;
			if (typeof value === "string" && matchIndex >= 0) {
				const full = match[0];
				const captureOffset = full.indexOf(value);
				const captureStart =
					captureOffset >= 0 ? matchIndex + captureOffset : matchIndex;
				const captureEnd = captureStart + value.length;
				const suffix = captureLineSuffix(text, captureEnd);
				const candidate = `${value}${suffix}`;

				if (!seen.has(candidate)) {
					seen.add(candidate);
					refs.push(candidate);
				}
			}
		}
	}

	return refs;
};

const extractPathsFromToolArgs = (args: unknown): string[] => {
	if (!args || typeof args !== "object") {
		return [];
	}

	const refs: string[] = [];
	const record = args as Record<string, unknown>;
	const directKeys = [
		"path",
		"file",
		"filePath",
		"filepath",
		"fileName",
		"filename",
	] as const;
	const listKeys = ["paths", "files", "filePaths"] as const;

	for (const key of directKeys) {
		const value = record[key];
		if (typeof value === "string") {
			refs.push(value);
		}
	}

	for (const key of listKeys) {
		const value = record[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string") {
					refs.push(item);
				}
			}
		}
	}

	return refs;
};

const extractFileReferencesFromContent = (
	content: unknown,
	options: RevealOptions,
): string[] => {
	if (typeof content === "string") {
		return extractFileReferencesFromText(content, options);
	}

	if (!Array.isArray(content)) {
		return [];
	}

	const refs: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object") {
			const block = part as ContentBlock;

			if (block.type === "text" && typeof block.text === "string") {
				refs.push(...extractFileReferencesFromText(block.text, options));
			}

			if (block.type === "toolCall") {
				refs.push(...extractPathsFromToolArgs(block.arguments));
			}
		}
	}

	return refs;
};

type MessageEntry = Extract<SessionEntry, { type: "message" }>;

const captureLineSuffix = (text: string, start: number): string => {
	const match = text.slice(start).match(/^[:#]L?\d+(?:[-,]L?\d+)*/);
	return match?.[0] ?? "";
};

const extractFileReferencesFromMessage = (
	message: MessageEntry["message"],
	options: RevealOptions,
): string[] => {
	if ("content" in message) {
		return extractFileReferencesFromContent(
			(message as { content: unknown }).content,
			options,
		);
	}

	if ("output" in message && typeof message.output === "string") {
		return extractFileReferencesFromText(message.output, options);
	}

	if ("summary" in message && typeof message.summary === "string") {
		return extractFileReferencesFromText(message.summary, options);
	}

	return [];
};

const extractFileReferencesFromEntry = (
	entry: SessionEntry,
	options: RevealOptions,
): string[] => {
	if (entry.type === "message") {
		return extractFileReferencesFromMessage(entry.message, options);
	}

	if (entry.type === "custom_message") {
		return extractFileReferencesFromContent(entry.content, options);
	}

	return [];
};

const sanitizeReference = (raw: string, options: RevealOptions): string => {
	let value = raw.trim();
	value = value.replace(options.sanitize.leadingTrim, "");
	value = value.replace(options.sanitize.trailingTrim, "");
	value = value.replace(options.sanitize.trailingPunctuation, "");
	return value;
};

const isCommentLikeReference = (value: string): boolean =>
	value.startsWith("//");

const stripLineSuffix = (value: string): NormalizedReference => {
	let pathOnly = value;
	let ranges: string | undefined;

	const hashIndex = pathOnly.lastIndexOf("#L");
	if (hashIndex >= 0) {
		const suffix = pathOnly.slice(hashIndex + 2);
		const hashMatch = suffix.match(/^(\d+)(?:-L?(\d+))?/i);
		if (hashMatch) {
			ranges = hashMatch[2] ? `${hashMatch[1]}-${hashMatch[2]}` : hashMatch[1];
			pathOnly = pathOnly.slice(0, hashIndex);
		}
	}

	const lastSeparator = Math.max(
		pathOnly.lastIndexOf("/"),
		pathOnly.lastIndexOf("\\"),
	);
	const segmentStart = lastSeparator >= 0 ? lastSeparator + 1 : 0;
	const segment = pathOnly.slice(segmentStart);
	const colonIndex = segment.indexOf(":");
	if (colonIndex >= 0 && /\d/.test(segment[colonIndex + 1] ?? "")) {
		const potential = segment.slice(colonIndex + 1);
		if (/^\d+(?:[-,]\d+)*(?:,\d+(?:-\d+)*)*$/.test(potential)) {
			ranges = ranges ?? potential;
		} else if (/^\d+(?::\d+)?$/.test(potential)) {
			const [line] = potential.split(":");
			ranges = ranges ?? line;
		}
		pathOnly = pathOnly.slice(0, segmentStart + colonIndex);
	}

	const lastColon = pathOnly.lastIndexOf(":");
	if (lastColon > lastSeparator) {
		const suffix = pathOnly.slice(lastColon + 1);
		if (/^\d+(?:[-,]\d+)*(?:,\d+(?:-\d+)*)*$/.test(suffix)) {
			ranges = ranges ?? suffix;
			pathOnly = pathOnly.slice(0, lastColon);
		} else if (/^\d+(?::\d+)?$/.test(suffix)) {
			const [line] = suffix.split(":");
			ranges = ranges ?? line;
			pathOnly = pathOnly.slice(0, lastColon);
		}
	}

	return { path: pathOnly, ranges };
};

const toTestReference = (
	value: string,
	options: RevealOptions,
): ExtractedReference => {
	const sanitized = sanitizeReference(value, options);
	if (!options.sanitize.stripLineSuffix) {
		return { path: sanitized };
	}

	return stripLineSuffix(sanitized);
};

const extractTestReferences = (
	text: string,
	options: RevealOptions,
): ExtractedReference[] =>
	extractFileReferencesFromText(text, options).map((value) =>
		toTestReference(value, options),
	);

const runExtractPatternTests = (options: RevealOptions): void => {
	const testCases = options.extract.testCases ?? [];
	for (const testCase of testCases) {
		const results = extractTestReferences(testCase.text, options);
		const expected = JSON.stringify(testCase.expected);
		const actual = JSON.stringify(results);

		if (actual !== expected) {
			throw new Error(
				`Extract pattern test failed for "${testCase.text}": expected ${expected}, got ${actual}`,
			);
		}
	}
};

const normalizeReferencePath = (
	raw: string,
	cwd: string,
	options: RevealOptions,
): NormalizedReference | null => {
	let candidate = sanitizeReference(raw, options);
	if (!candidate || isCommentLikeReference(candidate)) {
		return null;
	}

	if (candidate.startsWith("file://")) {
		try {
			candidate = fileURLToPath(candidate);
		} catch {
			return null;
		}
	}

	let ranges: string | undefined;
	if (options.sanitize.stripLineSuffix) {
		const stripped = stripLineSuffix(candidate);
		candidate = stripped.path;
		ranges = stripped.ranges;
	}

	if (!candidate || isCommentLikeReference(candidate)) {
		return null;
	}

	if (candidate.startsWith("~")) {
		candidate = path.join(os.homedir(), candidate.slice(1));
	}

	if (!path.isAbsolute(candidate)) {
		candidate = path.resolve(cwd, candidate);
	}

	candidate = path.normalize(candidate);
	const root = path.parse(candidate).root;
	if (candidate.length > root.length) {
		candidate = candidate.replace(/[\\/]+$/, "");
	}

	return { path: candidate, ranges };
};

const formatDisplayPath = (absolutePath: string, cwd: string): string => {
	const normalizedCwd = path.resolve(cwd);
	if (absolutePath.startsWith(normalizedCwd + path.sep)) {
		return path.relative(normalizedCwd, absolutePath);
	}
	return absolutePath;
};

const applyDirectorySuffix = (
	value: string,
	options: RevealOptions,
): string => {
	const suffix = options.directories.directorySuffix;
	if (!suffix) {
		return value;
	}

	const stripped = value.replace(/[\\/]+$/, "");
	if (!stripped) {
		return value;
	}

	if (stripped.endsWith(suffix)) {
		return stripped;
	}

	return `${stripped}${suffix}`;
};

const buildFileReference = (
	normalized: NormalizedReference,
	cwd: string,
	options: RevealOptions,
): FileReference | null => {
	let exists = false;
	let isDirectory = false;

	if (existsSync(normalized.path)) {
		exists = true;
		const stats = statSync(normalized.path);
		isDirectory = stats.isDirectory();
	}

	if (isDirectory && !options.directories.includeInSelector) {
		return null;
	}

	return {
		path: normalized.path,
		display: formatDisplayPath(normalized.path, cwd),
		exists,
		isDirectory,
		ranges: normalized.ranges,
	};
};

const collectRecentFileReferences = (
	entries: SessionEntry[],
	cwd: string,
	limit: number,
	options: RevealOptions,
): FileReference[] => {
	const results: FileReference[] = [];
	const indexByPath = new Map<string, number>();

	for (let i = entries.length - 1; i >= 0 && results.length < limit; i -= 1) {
		const refs = extractFileReferencesFromEntry(entries[i], options);
		for (let j = refs.length - 1; j >= 0 && results.length < limit; j -= 1) {
			const normalized = normalizeReferencePath(refs[j], cwd, options);
			if (normalized) {
				const existingIndex = indexByPath.get(normalized.path);
				if (existingIndex !== undefined) {
					const merged = mergeRanges(
						results[existingIndex].ranges,
						normalized.ranges,
					);
					results[existingIndex].ranges = merged;
				} else {
					const reference = buildFileReference(normalized, cwd, options);
					if (reference) {
						indexByPath.set(normalized.path, results.length);
						results.push(reference);
					}
				}
			}
		}
	}

	return results;
};

const findLatestFileReference = (
	entries: SessionEntry[],
	cwd: string,
	options: RevealOptions,
): FileReference | null => {
	const refs = collectRecentFileReferences(entries, cwd, 100, options);
	return refs.find((ref) => ref.exists) ?? null;
};

const showFileSelector = async (
	ctx: ExtensionContext,
	items: FileReference[],
	options: RevealOptions,
	selectedPath?: string | null,
): Promise<FileReference | null> => {
	const seenPaths = new Set<string>();
	const uniqueItems = items.filter((item) => {
		if (seenPaths.has(item.path)) {
			return false;
		}
		seenPaths.add(item.path);
		return true;
	});
	const orderedItems = uniqueItems.filter((item) => item.exists);

	const selectItems: SelectItem[] = orderedItems.map((item) => {
		const baseDisplay = item.isDirectory
			? applyDirectorySuffix(item.display, options)
			: item.display;
		const showRanges = options.showRanges;
		const display =
			!item.isDirectory && showRanges && item.ranges
				? `${baseDisplay}:${item.ranges}`
				: baseDisplay;
		const status = item.isDirectory ? " [directory]" : "";
		return {
			value: item.path,
			label: `${display}${status}`,
			description: "",
		};
	});

	return ctx.ui.custom<FileReference | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(
			new Text(theme.fg("accent", theme.bold("Select a file"))),
		);

		const searchInput = new Input();
		container.addChild(searchInput);
		container.addChild(new Spacer(1));

		const listContainer = new Container();
		container.addChild(listContainer);
		container.addChild(
			new Text(
				theme.fg("dim", "Type to filter • enter to select • esc to cancel"),
			),
		);
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		let filteredItems = selectItems;
		let selectList: SelectList | null = null;

		const updateList = () => {
			listContainer.clear();

			if (filteredItems.length === 0) {
				listContainer.addChild(
					new Text(theme.fg("warning", "  No matching files"), 0, 0),
				);
				selectList = null;
				return;
			}

			selectList = new SelectList(
				filteredItems,
				Math.min(filteredItems.length, 12),
				{
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				},
			);

			if (selectedPath) {
				const index = filteredItems.findIndex(
					(item) => item.value === selectedPath,
				);
				if (index >= 0) {
					selectList.setSelectedIndex(index);
				}
			}

			selectList.onSelect = (item) => {
				const selected = orderedItems.find(
					(entry) => entry.path === item.value,
				);
				done(selected ?? null);
			};
			selectList.onCancel = () => done(null);

			listContainer.addChild(selectList);
		};

		const applyFilter = () => {
			const query = searchInput.getValue();
			filteredItems = query
				? fuzzyFilter(
						selectItems,
						query,
						(item) => `${item.label} ${item.value} ${item.description ?? ""}`,
					)
				: selectItems;
			updateList();
		};

		applyFilter();

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				const kb = getEditorKeybindings();
				if (
					kb.matches(data, "selectUp") ||
					kb.matches(data, "selectDown") ||
					kb.matches(data, "selectConfirm") ||
					kb.matches(data, "selectCancel")
				) {
					if (selectList) {
						selectList.handleInput(data);
					} else if (kb.matches(data, "selectCancel")) {
						done(null);
					}
					tui.requestRender();
					return;
				}

				searchInput.handleInput(data);
				applyFilter();
				tui.requestRender();
			},
		};
	});
};

type EditCheckResult = {
	allowed: boolean;
	reason?: string;
	content?: string;
};

type FileActionOptions = {
	canQuickLook: boolean;
	canEdit: boolean;
	canReveal: boolean;
	canOpen: boolean;
	canAddToPrompt: boolean;
};

const ACTION_LABELS: Record<FileAction, string> = {
	reveal: "Reveal in Finder",
	open: "Open",
	addToPrompt: "Add to prompt",
	quicklook: "Open in Quick Look",
	edit: "Edit",
};

const buildActionItems = (
	actionOptions: FileActionOptions,
	options: RevealOptions,
): SelectItem[] => {
	const configuredOrder: FileAction[] = [...options.actionOrder];
	const defaultOrder: FileAction[] = [
		"reveal",
		"open",
		"addToPrompt",
		"quicklook",
		"edit",
	];
	const actionOrder =
		configuredOrder.length > 0 ? configuredOrder : defaultOrder;
	const availability: Record<FileAction, boolean> = {
		reveal: actionOptions.canReveal,
		open: actionOptions.canOpen,
		addToPrompt: actionOptions.canAddToPrompt,
		quicklook: actionOptions.canQuickLook,
		edit: actionOptions.canEdit,
	};

	return actionOrder
		.filter((action) => availability[action])
		.map((action) => ({
			value: action,
			label: ACTION_LABELS[action],
		}));
};

const getEditableContent = (
	target: FileReference,
	options: RevealOptions,
): EditCheckResult => {
	if (!existsSync(target.path)) {
		return { allowed: false, reason: "File not found" };
	}

	const stats = statSync(target.path);
	if (stats.isDirectory()) {
		return { allowed: false, reason: "Directories cannot be edited" };
	}

	if (stats.size >= options.maxEditBytes) {
		return { allowed: false, reason: "File is too large" };
	}

	const buffer = readFileSync(target.path);
	if (buffer.includes(0)) {
		return { allowed: false, reason: "File contains null bytes" };
	}

	return { allowed: true, content: buffer.toString("utf8") };
};

const showActionSelector = async (
	ctx: ExtensionContext,
	actionOptions: FileActionOptions,
	options: RevealOptions,
): Promise<FileAction | null> => {
	const actions = buildActionItems(actionOptions, options);

	return ctx.ui.custom<FileAction | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(
			new Text(theme.fg("accent", theme.bold("Choose action"))),
		);

		const selectList = new SelectList(actions, actions.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		selectList.onSelect = (item) => done(item.value as FileAction);
		selectList.onCancel = () => done(null);

		container.addChild(selectList);
		container.addChild(
			new Text(theme.fg("dim", "Press enter to confirm or esc to cancel")),
		);
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
};

const openPath = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	target: FileReference,
	options: RevealOptions,
): Promise<void> => {
	if (!existsSync(target.path)) {
		if (ctx.hasUI) {
			ctx.ui.notify(`File not found: ${target.path}`, "error");
		}
		return;
	}

	const isDirectory = target.isDirectory || statSync(target.path).isDirectory();
	if (isDirectory && !options.directories.allowOpen) {
		if (ctx.hasUI) {
			ctx.ui.notify("Opening directories is disabled", "warning");
		}
		return;
	}

	const [command, ...args] = options.openCommand(target);
	const result = await pi.exec(command, args);
	if (result.code !== 0 && ctx.hasUI) {
		const errorMessage =
			result.stderr?.trim() || `Failed to open ${target.path}`;
		ctx.ui.notify(errorMessage, "error");
	}
};

const openExternalEditor = (
	tui: TUI,
	editorCmd: CommandSpec,
	content: string,
): string | null => {
	const tmpFile = path.join(os.tmpdir(), `pi-reveal-edit-${Date.now()}.txt`);

	try {
		writeFileSync(tmpFile, content, "utf8");
		tui.stop();

		const [editor, ...editorArgs] = editorCmd;
		const result = spawnSync(editor, [...editorArgs, tmpFile], {
			stdio: "inherit",
		});

		if (result.status === 0) {
			return readFileSync(tmpFile, "utf8").replace(/\n$/, "");
		}

		return null;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {}
		tui.start();
		tui.requestRender(true);
	}
};

const editPath = async (
	ctx: ExtensionContext,
	target: FileReference,
	content: string,
	options: RevealOptions,
): Promise<void> => {
	const editorCmd = options.resolveEditorCommand(process.env);
	if (!editorCmd) {
		ctx.ui.notify("No editor configured. Set $VISUAL or $EDITOR.", "warning");
		return;
	}

	const updated = await ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) => {
			const status = new Text(
				theme.fg("dim", `Opening ${editorCmd.join(" ")}...`),
			);

			queueMicrotask(() => {
				const result = openExternalEditor(tui, editorCmd, content);
				done(result);
			});

			return status;
		},
	);

	if (updated === null) {
		ctx.ui.notify("Edit cancelled", "info");
		return;
	}

	try {
		writeFileSync(target.path, updated, "utf8");
	} catch {
		ctx.ui.notify(`Failed to save ${target.path}`, "error");
		return;
	}
};

const revealPath = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	target: FileReference,
	options: RevealOptions,
): Promise<void> => {
	if (!existsSync(target.path)) {
		if (ctx.hasUI) {
			ctx.ui.notify(`File not found: ${target.path}`, "error");
		}
		return;
	}

	const isDirectory = target.isDirectory || statSync(target.path).isDirectory();
	if (isDirectory && !options.directories.allowReveal) {
		if (ctx.hasUI) {
			ctx.ui.notify("Revealing directories is disabled", "warning");
		}
		return;
	}

	const [command, ...baseArgs] = options.revealCommand;
	let args: string[] = [];

	if (PLATFORM.isDarwin) {
		args = isDirectory ? [target.path] : ["-R", target.path];
	} else {
		args = [isDirectory ? target.path : path.dirname(target.path)];
	}

	const result = await pi.exec(command, [...baseArgs, ...args]);
	if (result.code !== 0 && ctx.hasUI) {
		const errorMessage =
			result.stderr?.trim() || `Failed to reveal ${target.path}`;
		ctx.ui.notify(errorMessage, "error");
	}
};

const quickLookPath = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	target: FileReference,
	options: RevealOptions,
): Promise<void> => {
	const quickLookCommand = options.quickLookCommand;

	if (!quickLookCommand) {
		if (ctx.hasUI) {
			ctx.ui.notify("Quick Look is only available on macOS", "warning");
		}
		return;
	}

	if (!existsSync(target.path)) {
		if (ctx.hasUI) {
			ctx.ui.notify(`File not found: ${target.path}`, "error");
		}
		return;
	}

	const isDirectory = target.isDirectory || statSync(target.path).isDirectory();
	if (isDirectory) {
		if (ctx.hasUI) {
			ctx.ui.notify("Quick Look only works on files", "warning");
		}
		return;
	}

	const [command, ...args] = quickLookCommand;
	const result = await pi.exec(command, [...args, target.path]);
	if (result.code !== 0 && ctx.hasUI) {
		const errorMessage =
			result.stderr?.trim() || `Failed to Quick Look ${target.path}`;
		ctx.ui.notify(errorMessage, "error");
	}
};

const addFileToPrompt = (
	ctx: ExtensionContext,
	target: FileReference,
	options: RevealOptions,
): void => {
	if (target.isDirectory && !options.directories.allowAddToPrompt) {
		ctx.ui.notify("Adding directories to the prompt is disabled", "warning");
		return;
	}

	const mentionBase = target.display || target.path;
	const mentionTarget = target.isDirectory
		? applyDirectorySuffix(mentionBase, options)
		: mentionBase;
	const mention = `@${mentionTarget}`;
	const current = ctx.ui.getEditorText();
	const separator = current && !current.endsWith(" ") ? " " : "";
	ctx.ui.setEditorText(`${current}${separator}${mention}`);
	ctx.ui.notify(`Added ${mention} to prompt`, "info");
};

const getActionOptions = (
	selection: FileReference,
	editCheck: EditCheckResult,
	options: RevealOptions,
): FileActionOptions => ({
	canQuickLook: Boolean(options.quickLookCommand) && !selection.isDirectory,
	canEdit: editCheck.allowed,
	canReveal: !selection.isDirectory || options.directories.allowReveal,
	canOpen: !selection.isDirectory || options.directories.allowOpen,
	canAddToPrompt:
		!selection.isDirectory || options.directories.allowAddToPrompt,
});

const hasAnyAction = (options: FileActionOptions): boolean =>
	[
		options.canQuickLook,
		options.canEdit,
		options.canReveal,
		options.canOpen,
		options.canAddToPrompt,
	].some(Boolean);

const handleFileAction = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	selection: FileReference,
	editCheck: EditCheckResult,
	action: FileAction,
	options: RevealOptions,
): Promise<void> => {
	if (action === "quicklook") {
		await quickLookPath(pi, ctx, selection, options);
		return;
	}

	if (action === "open") {
		await openPath(pi, ctx, selection, options);
		return;
	}

	if (action === "edit") {
		if (!editCheck.allowed || editCheck.content === undefined) {
			ctx.ui.notify(editCheck.reason ?? "File cannot be edited", "warning");
			return;
		}
		await editPath(ctx, selection, editCheck.content, options);
		return;
	}

	if (action === "addToPrompt") {
		addFileToPrompt(ctx, selection, options);
		return;
	}

	await revealPath(pi, ctx, selection, options);
};

const runFileBrowserLoop = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	references: FileReference[],
	options: RevealOptions,
	lastSelectedPath: string | null,
): Promise<void> => {
	const selection = await showFileSelector(
		ctx,
		references,
		options,
		lastSelectedPath,
	);
	if (!selection) {
		ctx.ui.notify("Reveal cancelled", "info");
		return;
	}

	if (!selection.exists) {
		ctx.ui.notify(`File not found: ${selection.path}`, "error");
		return;
	}

	const editCheck = getEditableContent(selection, options);
	const actionOptions = getActionOptions(selection, editCheck, options);
	if (!hasAnyAction(actionOptions)) {
		ctx.ui.notify("No actions available for this selection", "warning");
		return;
	}

	const action = await showActionSelector(ctx, actionOptions, options);
	if (!action) {
		await runFileBrowserLoop(pi, ctx, references, options, selection.path);
		return;
	}

	await handleFileAction(pi, ctx, selection, editCheck, action, options);
};

const runFileBrowser = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: RevealOptions,
): Promise<void> => {
	if (!ctx.hasUI) {
		ctx.ui.notify("Reveal requires interactive mode", "error");
		return;
	}

	const references = collectRecentFileReferences(
		ctx.sessionManager.getBranch(),
		ctx.cwd,
		100,
		options,
	);
	if (references.length === 0) {
		ctx.ui.notify("No file reference found in the session", "warning");
		return;
	}

	await runFileBrowserLoop(pi, ctx, references, options, null);
};

export const extension = (input: RevealOptionsInput = {}) => {
	const options = resolveOptions(input);
	if (options.extract.runTests) {
		runExtractPatternTests(options);
	}

	return (pi: ExtensionAPI): void => {
		const commandName = options.commandName;
		pi.registerCommand(commandName, {
			description: "Reveal, open, or edit files mentioned in the conversation",
			handler: async (_args, ctx) => {
				await runFileBrowser(pi, ctx, options);
			},
		});

		pi.registerShortcut(options.shortcuts.browse, {
			description: "Browse files mentioned in the session",
			handler: async (ctx) => {
				await runFileBrowser(pi, ctx, options);
			},
		});

		pi.registerShortcut(options.shortcuts.revealLatest, {
			description: "Reveal the latest file reference in Finder",
			handler: async (ctx) => {
				const entries = ctx.sessionManager.getBranch();
				const latest = findLatestFileReference(entries, ctx.cwd, options);

				if (!latest) {
					if (ctx.hasUI) {
						ctx.ui.notify("No file reference found in the session", "warning");
					}
					return;
				}

				await revealPath(pi, ctx, latest, options);
			},
		});

		pi.registerShortcut(options.shortcuts.quickLookLatest, {
			description: "Quick Look the latest file reference",
			handler: async (ctx) => {
				const entries = ctx.sessionManager.getBranch();
				const latest = findLatestFileReference(entries, ctx.cwd, options);

				if (!latest) {
					if (ctx.hasUI) {
						ctx.ui.notify("No file reference found in the session", "warning");
					}
					return;
				}

				await quickLookPath(pi, ctx, latest, options);
			},
		});
	};
};
