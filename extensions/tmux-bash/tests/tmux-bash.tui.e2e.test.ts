import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiE2eProject, type PiE2eProject } from "./testing/e2e-project.js";
import {
  bash,
  reply,
  scriptedToolCall,
  type ScriptedStep,
  writeScriptedProvider,
} from "./testing/scripted-provider.js";
import { runPiTui, type RunPiTuiCheckpoint } from "./testing/tui-pi.js";

const projects: PiE2eProject[] = [];
const doneMarker = "PI-TUI-DONE";

const createProject = (): PiE2eProject => {
  const project = createPiE2eProject();
  projects.push(project);
  return project;
};

const bashTool = (
  command: string,
  args: Record<string, unknown> = {},
  options: { delayMs?: number } = {},
): ScriptedStep => scriptedToolCall("bash", { command, ...args }, options);

const tmux = (args: Record<string, unknown>, options: { delayMs?: number } = {}): ScriptedStep =>
  scriptedToolCall("tmux", args, options);

const runTui = (
  project: PiE2eProject,
  script: ScriptedStep[],
  options: { waitFor?: string | RegExp; checkpoints?: RunPiTuiCheckpoint[] } = {},
): Promise<{ pane: string; checkpoints: Record<string, string> }> => {
  const scriptedProvider = writeScriptedProvider(project.tempRoot, script);

  return runPiTui({
    cwd: project.projectDir,
    agentDir: project.agentDir,
    extensions: [path.resolve("extensions/tmux-bash/src/index.ts"), scriptedProvider],
    prompt: "run scripted tool call",
    waitFor: options.waitFor ?? doneMarker,
    checkpoints: options.checkpoints,
    timeoutMs: 25_000,
  });
};

const truncatedCommandTitle = (command: string): string => {
  const compact = command.replace(/\s+/g, " ").trim();
  const truncated = compact.length > 80 ? `${compact.slice(0, 79)}…` : compact;
  return `$ ${truncated}`;
};

const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

const stripAnsi = (text: string): string => text.replace(ANSI_ESCAPE_PATTERN, "");

const trimmedPaneLines = (pane: string): string[] =>
  pane.split("\n").map((line) => stripAnsi(line).trim());

const bashTranscript = (pane: string): string => {
  const lines = trimmedPaneLines(pane);
  const start = lines.findIndex((line) => line.startsWith("$ "));
  if (start === -1) throw new Error(`Missing bash call in pane:\n${pane}`);

  const end = lines.findIndex((line, index) => index > start && line === doneMarker);
  if (end === -1) throw new Error(`Missing done marker in pane:\n${pane}`);

  return lines.slice(start, end).join("\n").trimEnd();
};

const stableBashTranscript = (pane: string): string =>
  stableFullOutputPath(bashTranscript(pane)).replace(/Took [0-9]+\.[0-9]s/g, "Took <duration>");

const transcriptUntilLine = (pane: string, startText: string, endText: string): string => {
  const lines = trimmedPaneLines(pane);
  const start = lines.findIndex((line) => line === startText);
  if (start === -1) throw new Error(`Missing transcript start ${startText}:\n${pane}`);

  const end = lines.findIndex((line, index) => index > start && line === endText);
  if (end === -1) throw new Error(`Missing transcript end ${endText}:\n${pane}`);

  return lines.slice(start, end).join("\n").trimEnd();
};

const transcriptUntilSeparator = (pane: string, startPrefix: string): string => {
  const lines = trimmedPaneLines(pane);
  const start = lines.findIndex((line) => line.startsWith(startPrefix));
  if (start === -1) throw new Error(`Missing transcript start ${startPrefix}:\n${pane}`);

  const end = lines.findIndex((line, index) => index > start && line.startsWith("─"));
  return lines
    .slice(start, end === -1 ? undefined : end)
    .join("\n")
    .trimEnd();
};

const stableFullOutputPath = (text: string): string =>
  text.replace(/Full output:\s*[\s\S]*?\]/g, "Full output: <path>]");

const stableTmuxToolTranscript = (pane: string, startText: string): string =>
  stableFullOutputPath(transcriptUntilLine(pane, startText, doneMarker)).replace(/@\d+/g, "@<id>");

const stablePollMessageTranscript = (pane: string, windowTitle: string): string =>
  stableFullOutputPath(transcriptUntilSeparator(pane, `↻ tmux poll: ${windowTitle} @`)).replace(
    /@\d+/g,
    "@<id>",
  );

const numberedLines = (prefix: string, start: number, end: number): string =>
  Array.from(
    { length: end - start + 1 },
    (_, index) => `${prefix}-${String(start + index).padStart(3, "0")}`,
  ).join("\n");

afterEach(() => {
  projects.forEach((project) => project.cleanup());
  projects.length = 0;
});

describe("tmux-bash TUI rendering", () => {
  it("renders immediately-backgrounded bash calls without timeout metadata", async () => {
    const project = createProject();
    const result = await runTui(project, [
      bash('echo "hi" && sleep 80 && echo "bye"', { background: true, timeout: 1 }),
      reply(doneMarker),
    ]);

    expect(result.pane).toContain('$ echo "hi" && sleep 80 && echo "bye" (background)');
    expect(result.pane).toContain(
      "Started in background tmux window. Result will be reported when it finishes.",
    );
    expect(result.pane).toContain("Attach with: tmux");
    expect(result.pane).not.toContain("bg (timeout 1s)");
    expect(result.pane).not.toContain("(background) (timeout 1s)");
  }, 30_000);

  it("renders foreground timeout metadata when timeout controls execution", async () => {
    const project = createProject();
    const result = await runTui(project, [
      bash("printf starting && sleep 5", {
        background: false,
        timeout: 1,
        timeoutAction: "background",
      }),
      reply(doneMarker),
    ]);

    expect(result.pane).toContain("$ printf starting && sleep 5 (timeout 1s)");
    expect(result.pane).toContain(
      "Still running after 1s in background tmux. Use tmux peek/list/kill to inspect or stop it. Result will be reported when it finishes.",
    );
    expect(result.pane).not.toContain("Took 1s");
    expect(result.pane).not.toContain("$ printf starting && sleep 5 (background)");
  }, 30_000);

  it("renders foreground streaming progress before completion", async () => {
    const project = createProject();
    const result = await runTui(
      project,
      [
        bash("printf 'foreground-start\\n'; sleep 3; printf 'foreground-%s\\n' done", {
          timeout: 10,
          timeoutAction: "background",
        }),
        reply(doneMarker),
      ],
      {
        checkpoints: [
          {
            name: "streaming",
            waitFor: /foreground-start[\s\S]*Elapsed [0-9]+\.[0-9]s/,
            timeoutMs: 8_000,
          },
        ],
      },
    );

    expect(result.checkpoints.streaming).toContain("foreground-start");
    expect(result.checkpoints.streaming).not.toContain("foreground-done");
    expect(result.checkpoints.streaming).toMatch(/Elapsed [0-9]+\.[0-9]s/);
    expect(result.pane).toContain("foreground-start");
    expect(result.pane).toContain("foreground-done");
    expect(result.pane).toMatch(/Took [0-9]+\.[0-9]s/);
  }, 30_000);

  it("renders background poll output without requesting another assistant turn", async () => {
    const project = createProject();
    const result = await runTui(
      project,
      [
        bash("printf 'poll-one\\npoll-two\\n'; sleep 5", {
          background: true,
          pollInterval: 1,
          pollLines: 5,
        }),
        reply(doneMarker),
      ],
      { waitFor: "poll-two" },
    );

    expect(result.pane).toContain(
      "Started in background tmux window and polling every 1s. Result will be reported when it finishes.",
    );
    expect(result.pane).toContain("Attach with: tmux");
    expect(result.pane).toContain("poll-one");
    expect(result.pane).toContain("poll-two");
    expect(result.pane).toContain(doneMarker);
    expect(result.pane).not.toContain("No more faux responses queued");
  }, 30_000);

  it("renders fully-fitting bash output while collapsed", async () => {
    const project = createProject();
    const command = "printf 'fit-line-1\\nfit-line-2\\nfit-line-3\\n'";
    const result = await runTui(project, [bashTool(command), reply(doneMarker)]);

    expect(stableBashTranscript(result.pane))
      .toBe(`$ printf 'fit-line-1\\nfit-line-2\\nfit-line-3\\n'
fit-line-1
fit-line-2
fit-line-3

Took <duration>`);
  }, 30_000);

  it("renders overflowing bash output while collapsed", async () => {
    const project = createProject();
    const command = "for i in $(seq 1 400); do printf 'overflow-line-%03d\\n' \"$i\"; done";
    const result = await runTui(project, [bashTool(command), reply(doneMarker)]);

    expect(stableBashTranscript(result.pane))
      .toBe(`$ for i in $(seq 1 400); do printf 'overflow-line-%03d\\n' "$i"; done
... (395 earlier lines, ctrl+o to expand)
overflow-line-396
overflow-line-397
overflow-line-398
overflow-line-399
overflow-line-400

Took <duration>`);
  }, 30_000);

  it("renders truncated overflowing bash output while collapsed", async () => {
    const project = createProject();
    const command = "for i in $(seq 1 4000); do printf 'overflow-line-%03d\\n' \"$i\"; done";
    const result = await runTui(project, [bashTool(command), reply(doneMarker)]);

    expect(stableBashTranscript(result.pane))
      .toBe(`$ for i in $(seq 1 4000); do printf 'overflow-line-%03d\\n' "$i"; done
... (1997 earlier lines, ctrl+o to expand)
overflow-line-3999
overflow-line-4000

[Showing lines 2001-4000 of 4000. Full output: <path>]

Took <duration>`);
  }, 30_000);

  it("renders fully-fitting peek output while collapsed", async () => {
    const project = createProject();
    const command = "printf 'peek-line-1\\npeek-line-2\\npeek-line-3\\n'; sleep 30";
    const result = await runTui(project, [
      bash(command, { background: true, name: "peek-fit" }),
      tmux({ action: "peek", window: "all" }, { delayMs: 500 }),
      reply(doneMarker),
    ]);

    expect(stableTmuxToolTranscript(result.pane, "tmux peek :all")).toBe(`tmux peek :all
✓ tmux window: peek-fit @<id>
$ printf 'peek-line-1\\npeek-line-2\\npeek-line-3\\n'; sleep 30
peek-line-1
peek-line-2
peek-line-3

Attach with: tmux switch-client -t @<id>`);
  }, 30_000);

  it("expands collapsed overflowing peek output with ctrl-o", async () => {
    const project = createProject();
    const command = "for i in $(seq 1 8); do printf 'peek-overflow-%03d\\n' \"$i\"; done; sleep 30";
    const result = await runTui(
      project,
      [
        bash(command, { background: true, name: "peek-overflow" }),
        tmux({ action: "peek", window: "all" }, { delayMs: 500 }),
        reply(doneMarker),
      ],
      {
        checkpoints: [{ name: "collapsed", waitFor: doneMarker, keys: ["C-o"], delayMs: 300 }],
        waitFor: "peek-overflow-002",
      },
    );

    expect(stableTmuxToolTranscript(result.checkpoints.collapsed, "tmux peek :all"))
      .toBe(`tmux peek :all
✓ tmux window: peek-overflow @<id>
$ for i in $(seq 1 8); do printf 'peek-overflow-%03d\\n' "$i"; done; sleep 30
... (3 earlier lines, ctrl+o to expand)
peek-overflow-004
peek-overflow-005
peek-overflow-006
peek-overflow-007
peek-overflow-008

Attach with: tmux switch-client -t @<id>`);
    expect(stableTmuxToolTranscript(result.pane, "tmux peek :all")).toBe(`tmux peek :all
✓ tmux window: peek-overflow @<id>
$ for i in $(seq 1 8); do printf 'peek-overflow-%03d\\n' "$i"; done; sleep 30
peek-overflow-001
peek-overflow-002
peek-overflow-003
peek-overflow-004
peek-overflow-005
peek-overflow-006
peek-overflow-007
peek-overflow-008

Attach with: tmux switch-client -t @<id>`);
  }, 30_000);

  it("renders overflowing peek output while collapsed", async () => {
    const project = createProject();
    const command =
      "for i in $(seq 1 400); do printf 'peek-overflow-%03d\\n' \"$i\"; done; sleep 30";
    const result = await runTui(project, [
      bash(command, { background: true, name: "peek-overflow-400" }),
      tmux({ action: "peek", window: "all" }, { delayMs: 500 }),
      reply(doneMarker),
    ]);

    expect(stableTmuxToolTranscript(result.pane, "tmux peek :all")).toBe(`tmux peek :all
✓ tmux window: peek-overflow-400 @<id>
$ for i in $(seq 1 400); do printf 'peek-overflow-%03d\\n' "$i"; done; sleep 30
... (395 earlier lines, ctrl+o to expand)
${numberedLines("peek-overflow", 396, 400)}

Attach with: tmux switch-client -t @<id>`);
  }, 30_000);

  it("renders truncated overflowing peek output while collapsed", async () => {
    const project = createProject();
    const command =
      "for i in $(seq 1 4000); do printf 'peek-truncated-%03d\\n' \"$i\"; done; sleep 30";
    const result = await runTui(project, [
      bash(command, { background: true, name: "peek-truncated" }),
      tmux({ action: "peek", window: "all" }, { delayMs: 500 }),
      reply(doneMarker),
    ]);

    expect(stableTmuxToolTranscript(result.pane, "tmux peek :all")).toBe(`tmux peek :all
✓ tmux window: peek-truncated @<id>
$ for i in $(seq 1 4000); do printf 'peek-truncated-%03d\\n' "$i"; done; sleep 30
... (1997 earlier lines, ctrl+o to expand)
peek-truncated-3999
peek-truncated-4000

[Showing lines 2001-4000 of 4000. Full output: <path>]

Attach with: tmux switch-client -t @<id>`);
  }, 30_000);

  it("renders poll action and periodic poll output exactly", async () => {
    const project = createProject();
    const command = "for i in $(seq 1 3); do printf 'poll-fit-%s\\n' \"$i\"; done; sleep 30";
    const result = await runTui(
      project,
      [
        bash(command, { background: true, name: "poll-fit" }),
        tmux({ action: "poll", window: 1, pollInterval: 1, pollLines: 5 }, { delayMs: 500 }),
        reply(doneMarker),
      ],
      { waitFor: "poll-fit-3" },
    );

    expect(stableTmuxToolTranscript(result.pane, "tmux poll :1")).toBe(`tmux poll :1
✓ Polling poll-fit every 1s.`);
    expect(stablePollMessageTranscript(result.pane, "poll-fit")).toBe(`↻ tmux poll: poll-fit @<id>
$ for i in $(seq 1 3); do printf 'poll-fit-%s\\n' "$i"; done; sleep 30
poll-fit-1
poll-fit-2
poll-fit-3

Attach with: tmux switch-client -t @<id>`);
  }, 30_000);

  it("renders overflowing periodic poll output exactly", async () => {
    const project = createProject();
    const command =
      "for i in $(seq 1 400); do printf 'poll-overflow-%03d\\n' \"$i\"; done; sleep 30";
    const result = await runTui(
      project,
      [
        bash(command, { background: true, name: "poll-overflow" }),
        tmux({ action: "poll", window: 1, pollInterval: 1, pollLines: 5 }, { delayMs: 500 }),
        reply(doneMarker),
      ],
      { waitFor: "poll-overflow-400" },
    );

    expect(stablePollMessageTranscript(result.pane, "poll-overflow"))
      .toBe(`↻ tmux poll: poll-overflow @<id>
$ for i in $(seq 1 400); do printf 'poll-overflow-%03d\\n' "$i"; done; sleep 30
... (395 earlier lines, ctrl+o to expand)
${numberedLines("poll-overflow", 396, 400)}

Attach with: tmux switch-client -t @<id>`);
  }, 30_000);

  it("renders truncated overflowing periodic poll output exactly", async () => {
    const project = createProject();
    const command =
      "for i in $(seq 1 4000); do printf 'poll-truncated-%03d\\n' \"$i\"; done; sleep 30";
    const result = await runTui(
      project,
      [
        bash(command, { background: true, name: "poll-truncated" }),
        tmux({ action: "poll", window: 1, pollInterval: 1, pollLines: 5 }, { delayMs: 500 }),
        reply(doneMarker),
      ],
      { waitFor: "poll-truncated-4000" },
    );

    expect(stablePollMessageTranscript(result.pane, "poll-truncated"))
      .toBe(`↻ tmux poll: poll-truncated @<id>
$ for i in $(seq 1 4000); do printf 'poll-truncated-%03d\\n' "$i"; done; sleep 30
... (1997 earlier lines, ctrl+o to expand)
poll-truncated-3999
poll-truncated-4000

[Showing lines 2001-4000 of 4000. Full output: <path>]

Attach with: tmux switch-client -t @<id>`);
  }, 30_000);

  it("truncates long bash call titles", async () => {
    const project = createProject();
    const command =
      "printf 'long-title-ok\\n'; printf 'abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz\\n' >/dev/null";
    const result = await runTui(project, [bash(command), reply(doneMarker)]);

    expect(result.pane).toContain(truncatedCommandTitle(command));
    expect(result.pane).toContain("long-title-ok");
  }, 30_000);
});
