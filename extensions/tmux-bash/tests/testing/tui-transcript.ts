const ANSI_ESCAPE = String.raw`\u001B`;
const BELL = String.raw`\u0007`;
export const ANSI_ESCAPE_PATTERN = new RegExp(
  `${ANSI_ESCAPE}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BELL}]*(?:${BELL}|${ANSI_ESCAPE}\\\\)|[()][A-Za-z0-9])`,
  "g",
);
const FULL_OUTPUT_PATH_IN_ANSI_PATTERN = new RegExp(`Full output: [^\\]${ANSI_ESCAPE}\\n]+`, "g");

type AnsiToken = {
  text: string;
  ansi: boolean;
};

export const stripAnsi = (text: string): string => text.replace(ANSI_ESCAPE_PATTERN, "");

const ansiTokens = (line: string): AnsiToken[] => {
  const tokens: AnsiToken[] = [];
  let index = 0;
  for (const match of line.matchAll(ANSI_ESCAPE_PATTERN)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > index) {
      tokens.push(...Array.from(line.slice(index, matchIndex), (text) => ({ text, ansi: false })));
    }
    tokens.push({ text: match[0], ansi: true });
    index = matchIndex + match[0].length;
  }
  tokens.push(...Array.from(line.slice(index), (text) => ({ text, ansi: false })));
  return tokens;
};

const lastVisibleContentIndex = (tokens: AnsiToken[]): number =>
  tokens.reduce(
    (last, token, index) => (!token.ansi && token.text.trim() !== "" ? index : last),
    -1,
  );

const trimAnsiLineEnd = (line: string): string => {
  const tokens = ansiTokens(line);
  const lastContentIndex = lastVisibleContentIndex(tokens);
  if (lastContentIndex === -1) return "";

  return tokens
    .slice(0, lastContentIndex + 1)
    .map((token) => token.text)
    .join("");
};

export const ansiBashTranscript = (pane: string, doneMarker: string): string => {
  const lines = pane.split("\n");
  const visibleLines = lines.map((line) => stripAnsi(line).trim());
  const start = visibleLines.findIndex((line) => line.startsWith("$ "));
  if (start === -1) throw new Error(`Missing ANSI bash call in pane:\n${pane}`);

  const end = visibleLines.findIndex((line, index) => index > start && line === doneMarker);
  if (end === -1) throw new Error(`Missing ANSI done marker in pane:\n${pane}`);

  return lines.slice(start, end).map(trimAnsiLineEnd).join("\n").trimEnd();
};

const normalizeWrappedFullOutputPaths = (text: string): string => {
  const lines = text.split("\n");
  const normalized: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const visible = stripAnsi(line).trim();
    const nextVisible = stripAnsi(lines[index + 1] ?? "").trim();

    const isStandaloneFullOutputNotice = visible === "[Full output: <path>]";
    const isWrappedFullOutputNotice =
      visible.startsWith("[Full output: <path>") &&
      !visible.endsWith("]") &&
      (nextVisible.startsWith("/") || nextVisible.endsWith("]"));

    if (isWrappedFullOutputNotice || isStandaloneFullOutputNotice) {
      index += isWrappedFullOutputNotice ? 1 : 0;
    } else {
      normalized.push(line);
    }
  }

  return normalized.join("\n").replace(/\n{3,}/g, "\n\n");
};

export const stableFullOutputPath = (text: string): string =>
  text.replace(/Full output:\s*[\s\S]*?\]/g, "Full output: <path>]");

export const stableAnsiBashTranscript = (pane: string, doneMarker: string): string =>
  normalizeWrappedFullOutputPaths(
    ansiBashTranscript(pane, doneMarker)
      .replace(/Took [0-9]+\.[0-9]s/g, "Took <duration>")
      .replace(FULL_OUTPUT_PATH_IN_ANSI_PATTERN, "Full output: <path>"),
  );

export const stableContextOutput = (text: string): string =>
  normalizeWrappedFullOutputPaths(
    text.replace(/Full output: [^\]\n]+/g, "Full output: <path>"),
  ).trimEnd();
