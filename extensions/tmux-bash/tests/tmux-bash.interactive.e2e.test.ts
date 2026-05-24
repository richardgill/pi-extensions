import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createPiE2eWorkspace, type PiE2eWorkspace } from "./testing/pi-test-utils";
import {
  bash,
  providerError,
  reply,
  scriptedToolCall,
  scriptedToolCallWithLatestWindowId,
  type ScriptedStep,
  writeScriptedProvider,
} from "./testing/scripted-provider";
import { runPiTui, type RunPiTuiCheckpoint, type RunPiTuiResult } from "./testing/pi-interactive";
import {
  ansiBashTranscript,
  ANSI_ESCAPE_PATTERN,
  stableFullOutputPath,
  stripAnsi,
} from "./testing/tui-transcript";

const doneMarker = "PI-TUI-DONE";

const createWorkspace = (tmuxBashConfig: Record<string, unknown> = {}): PiE2eWorkspace => {
  const workspace = createPiE2eWorkspace({
    tmuxBashConfig: { pollDelivery: "display", ...tmuxBashConfig },
  });
  onTestFinished(() => workspace.cleanup());
  return workspace;
};

const bashTool = (
  command: string,
  args: Record<string, unknown> = {},
  options: { delayMs?: number } = {},
): ScriptedStep => scriptedToolCall("bash", { command, ...args }, options);

const tmux = (args: Record<string, unknown>, options: { delayMs?: number } = {}): ScriptedStep =>
  scriptedToolCall("tmux", args, options);

const tmuxForLatestWindow = (
  args: Record<string, unknown>,
  options: { delayMs?: number } = {},
): ScriptedStep => scriptedToolCallWithLatestWindowId("tmux", args, options);

const runTui = (
  workspace: PiE2eWorkspace,
  script: ScriptedStep[],
  options: {
    waitFor?: string | RegExp;
    checkpoints?: RunPiTuiCheckpoint[];
    captureAnsi?: boolean;
  } = {},
): Promise<RunPiTuiResult> => {
  const scriptedProvider = writeScriptedProvider(workspace.tempRoot, script);

  return runPiTui({
    cwd: workspace.projectDir,
    agentDir: workspace.agentDir,
    extensions: [path.resolve("extensions/tmux-bash/src/index.ts"), scriptedProvider],
    prompt: "run scripted tool call",
    waitFor: options.waitFor ?? doneMarker,
    checkpoints: options.checkpoints,
    captureAnsi: options.captureAnsi,
    timeoutMs: 25_000,
  });
};

const truncatedCommandTitle = (command: string): string => {
  const compact = command.replace(/\s+/g, " ").trim();
  const truncated = compact.length > 80 ? `${compact.slice(0, 79)}…` : compact;
  return `$ ${truncated}`;
};

const paneLines = (pane: string): string[] =>
  pane
    .split("\n")
    .map((line) => stripAnsi(line).trimEnd())
    .map((line) => (line.startsWith(" ") ? line.slice(1) : line));

const bashTranscript = (pane: string): string => {
  const lines = paneLines(pane);
  const start = lines.findIndex((line) => line.startsWith("$ "));
  if (start === -1) throw new Error(`Missing bash call in pane:\n${pane}`);

  const end = lines.findIndex((line, index) => index > start && line === doneMarker);
  if (end === -1) throw new Error(`Missing done marker in pane:\n${pane}`);

  return lines.slice(start, end).join("\n").trimEnd();
};

const stableBashTranscript = (pane: string): string =>
  stableFullOutputPath(bashTranscript(pane)).replace(/Took [0-9]+\.[0-9]s/g, "Took <duration>");

const transcriptUntilLine = (pane: string, startText: string, endText: string): string => {
  const lines = paneLines(pane);
  const start = lines.findIndex((line) => line.startsWith(startText));
  if (start === -1) throw new Error(`Missing transcript start ${startText}:\n${pane}`);

  const end = lines.findIndex((line, index) => index > start && line === endText);
  if (end === -1) throw new Error(`Missing transcript end ${endText}:\n${pane}`);

  return lines.slice(start, end).join("\n").trimEnd();
};

const transcriptUntilSeparator = (pane: string, startPrefix: string): string => {
  const lines = paneLines(pane);
  const start = lines.findIndex((line) => line.startsWith(startPrefix));
  if (start === -1) throw new Error(`Missing transcript start ${startPrefix}:\n${pane}`);

  const end = lines.findIndex(
    (line, index) =>
      index > start && (line.startsWith("─") || line.startsWith("Error: No more faux")),
  );
  return lines
    .slice(start, end === -1 ? undefined : end)
    .join("\n")
    .trimEnd();
};

const stableTmuxToolTranscript = (pane: string, startText: string): string =>
  stableFullOutputPath(transcriptUntilLine(pane, startText, doneMarker)).replace(/@\d+/g, "@<id>");

const stablePollMessageTranscript = (pane: string, windowTitle: string): string =>
  stableFullOutputPath(transcriptUntilSeparator(pane, `tmux poll: ${windowTitle} @`)).replace(
    /@\d+/g,
    "@<id>",
  );

const stableCompletionMessageTranscript = (pane: string): string =>
  stableFullOutputPath(transcriptUntilSeparator(pane, "Background bash "));

const numberedLines = (prefix: string, start: number, end: number): string =>
  Array.from(
    { length: end - start + 1 },
    (_, index) => `${prefix}-${String(start + index).padStart(3, "0")}`,
  ).join("\n");

const singleIndentBlock = (text: string): string =>
  text
    .split("\n")
    .map((line) => ` ${line}`)
    .join("\n");

const countOccurrences = (text: string, needle: string): number => text.split(needle).length - 1;

type BashOutputCase = {
  name: string;
  command: string;
  expectedTranscript: string;
};

type TmuxOutputCase = BashOutputCase & {
  windowName: string;
  waitFor?: string;
  expectedActionTranscript?: string;
};

const runBashCard = (command: string): Promise<RunPiTuiResult> => {
  const workspace = createWorkspace();
  return runTui(workspace, [bashTool(command), reply(doneMarker)]);
};

const runPeekCard = (testCase: TmuxOutputCase): Promise<RunPiTuiResult> => {
  const workspace = createWorkspace();
  return runTui(workspace, [
    bash(testCase.command, { background: true, name: testCase.windowName }),
    tmuxForLatestWindow({ action: "peek" }, { delayMs: 500 }),
    reply(doneMarker),
  ]);
};

const runPollCard = (testCase: TmuxOutputCase): Promise<RunPiTuiResult> => {
  const workspace = createWorkspace();
  return runTui(
    workspace,
    [
      bash(testCase.command, { background: true, name: testCase.windowName }),
      tmuxForLatestWindow({ action: "poll", pollInterval: 1, pollLines: 5 }, { delayMs: 500 }),
      reply(doneMarker),
    ],
    { waitFor: testCase.waitFor },
  );
};

const bashOutputCases: BashOutputCase[] = [
  {
    name: "fully-fitting",
    command: "printf 'fit-line-1\\nfit-line-2\\nfit-line-3\\n'",
    expectedTranscript: `$ printf 'fit-line-1\\nfit-line-2\\nfit-line-3\\n'

fit-line-1
fit-line-2
fit-line-3

Took <duration>`,
  },
  {
    name: "overflowing",
    command: "for i in $(seq 1 400); do printf 'overflow-line-%03d\\n' \"$i\"; done",
    expectedTranscript: `$ for i in $(seq 1 400); do printf 'overflow-line-%03d\\n' "$i"; done

... (395 earlier lines, ctrl+o to expand)
overflow-line-396
overflow-line-397
overflow-line-398
overflow-line-399
overflow-line-400

Took <duration>`,
  },
  {
    name: "truncated overflowing",
    command: "for i in $(seq 1 4000); do printf 'overflow-line-%03d\\n' \"$i\"; done",
    expectedTranscript: `$ for i in $(seq 1 4000); do printf 'overflow-line-%03d\\n' "$i"; done

... (1995 earlier lines, ctrl+o to expand)
overflow-line-3996
overflow-line-3997
overflow-line-3998
overflow-line-3999
overflow-line-4000

[Full output: <path>]

Took <duration>`,
  },
];

const peekOutputCases: TmuxOutputCase[] = [
  {
    name: "fully-fitting",
    windowName: "peek-fit",
    command: "printf 'peek-line-1\\npeek-line-2\\npeek-line-3\\n'; sleep 30",
    expectedTranscript: `tmux peek @<id>
✓ tmux window: peek-fit @<id>
 $ printf 'peek-line-1\\npeek-line-2\\npeek-line-3\\n'; sleep 30
 peek-line-1
 peek-line-2
 peek-line-3

 Attach with: tmux switch-client -t @<id>`,
  },
  {
    name: "overflowing",
    windowName: "peek-overflow-400",
    command: "for i in $(seq 1 400); do printf 'peek-overflow-%03d\\n' \"$i\"; done; sleep 30",
    expectedTranscript: `tmux peek @<id>
✓ tmux window: peek-overflow-400 @<id>
 $ for i in $(seq 1 400); do printf 'peek-overflow-%03d\\n' "$i"; done; sleep 30
 ... (395 earlier lines, ctrl+o to expand)
${singleIndentBlock(numberedLines("peek-overflow", 396, 400))}

 Attach with: tmux switch-client -t @<id>`,
  },
  {
    name: "truncated overflowing",
    windowName: "peek-truncated",
    command: "for i in $(seq 1 4000); do printf 'peek-truncated-%03d\\n' \"$i\"; done; sleep 30",
    expectedTranscript: `tmux peek @<id>
✓ tmux window: peek-truncated @<id>
 $ for i in $(seq 1 4000); do printf 'peek-truncated-%03d\\n' "$i"; done; sleep 30
 ... (1998 earlier lines, ctrl+o to expand)
 peek-truncated-3999
 peek-truncated-4000

 [Showing lines 2001-4000 of 4000. Full output: <path>]

 Attach with: tmux switch-client -t @<id>`,
  },
];

const pollOutputCases: TmuxOutputCase[] = [
  {
    name: "fully-fitting",
    windowName: "poll-fit",
    command: "for i in $(seq 1 3); do printf 'poll-fit-%s\\n' \"$i\"; done; sleep 30",
    waitFor: "poll-fit-3",
    expectedActionTranscript: `tmux poll @<id>
✓ Polling poll-fit every 1s.`,
    expectedTranscript: `tmux poll: poll-fit @<id>

$ for i in $(seq 1 3); do printf 'poll-fit-%s\\n' "$i"; done; sleep 30
poll-fit-1
poll-fit-2
poll-fit-3

Attach with: tmux switch-client -t @<id>`,
  },
  {
    name: "overflowing",
    windowName: "poll-overflow",
    command: "for i in $(seq 1 400); do printf 'poll-overflow-%03d\\n' \"$i\"; done; sleep 30",
    waitFor: "poll-overflow-400",
    expectedTranscript: `tmux poll: poll-overflow @<id>

$ for i in $(seq 1 400); do printf 'poll-overflow-%03d\\n' "$i"; done; sleep 30
... (3 earlier lines, ctrl+o to expand)
poll-overflow-399
poll-overflow-400

[Showing lines 396-400 of 400. Full output: <path>]

Attach with: tmux switch-client -t @<id>`,
  },
  {
    name: "truncated overflowing",
    windowName: "poll-truncated",
    command: "for i in $(seq 1 4000); do printf 'poll-truncated-%03d\\n' \"$i\"; done; sleep 30",
    waitFor: "poll-truncated-4000",
    expectedTranscript: `tmux poll: poll-truncated @<id>

$ for i in $(seq 1 4000); do printf 'poll-truncated-%03d\\n' "$i"; done; sleep 30
... (3 earlier lines, ctrl+o to expand)
poll-truncated-3999
poll-truncated-4000

[Showing lines 3996-4000 of 4000. Full output: <path>]

Attach with: tmux switch-client -t @<id>`,
  },
];

describe("tmux-bash TUI rendering", () => {
  it("renders immediately-backgrounded bash calls without timeout metadata", async () => {
    const workspace = createWorkspace();
    const result = await runTui(workspace, [
      bash('echo "hi" && sleep 80 && echo "bye"', { background: true, timeout: 1 }),
      reply(doneMarker),
    ]);

    expect(result.pane).toContain('$ echo "hi" && sleep 80 && echo "bye" (background)');
    expect(result.pane).toMatch(
      /Started in background tmux window: echo @\d+\.\s+Result will be reported when it finishes\./,
    );
    expect(result.pane).toContain("Attach with: tmux");
    expect(result.pane).not.toContain("bg (timeout 1s)");
    expect(result.pane).not.toContain("(background) (timeout 1s)");
  }, 30_000);

  it("renders foreground timeout metadata when timeout controls execution", async () => {
    const workspace = createWorkspace();
    const result = await runTui(workspace, [
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
    const workspace = createWorkspace();
    const result = await runTui(
      workspace,
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

  it("renders background poll metadata in the bash call title", async () => {
    const workspace = createWorkspace();
    const result = await runTui(workspace, [
      bash("printf 'poll-title\\n'; sleep 5", {
        background: true,
        pollInterval: 1,
        pollLines: 5,
      }),
      reply(doneMarker),
    ]);

    expect(result.pane).toContain("$ printf 'poll-title\\n'; sleep 5 (background, poll 1s)");
    expect(result.pane).not.toContain("$ printf 'poll-title\\n'; sleep 5 (background)\n");
  }, 30_000);

  it("renders background bash completion cards without tmux target labels", async () => {
    const workspace = createWorkspace();
    const result = await runTui(
      workspace,
      [
        bash("printf 'completion-one\\ncompletion-two\\n'", {
          background: true,
          name: "completion-card",
        }),
        reply(doneMarker),
      ],
      { waitFor: "Background bash finished" },
    );

    expect(stableCompletionMessageTranscript(result.pane)).toBe(`Background bash finished

completion-one
completion-two`);
    expect(result.pane).not.toContain("Background job");
    expect(result.pane).not.toContain("Output:");
    expect(result.pane).not.toContain("tmux:");
  }, 30_000);

  it("surfaces provider errors from background completion follow-up turns", async () => {
    const workspace = createWorkspace();
    const result = await runTui(
      workspace,
      [
        bash("printf 'before-provider-error\\n'", {
          background: true,
          name: "completion-error",
        }),
        reply(doneMarker),
        providerError("WebSocket error"),
      ],
      { waitFor: "Error: WebSocket error" },
    );

    expect(result.pane).toContain("Background bash finished");
    expect(result.pane).toContain("before-provider-error");
    expect(result.pane).toContain("Error: WebSocket error");
    expect(result.pane).not.toContain("Working...");
  }, 30_000);

  it("renders background poll output without requesting another assistant turn", async () => {
    const workspace = createWorkspace();
    const result = await runTui(
      workspace,
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

    expect(result.pane).toMatch(
      /Started in background tmux window: printf @\d+\. Polling every 1s\.\s+Result will be reported when it finishes\./,
    );
    expect(result.pane).toContain("Attach with: tmux");
    expect(result.pane).toContain("poll-one");
    expect(result.pane).toContain("poll-two");
    expect(result.pane).toContain(doneMarker);
    expect(result.pane).not.toContain("No more faux responses queued");
  }, 30_000);

  it("renders multiple background poll cards while output changes", async () => {
    const workspace = createWorkspace();
    const result = await runTui(
      workspace,
      [
        bash("for i in $(seq 1 8); do printf 'multi-poll-%02d\\n' \"$i\"; sleep 1; done", {
          background: true,
          name: "poll-multi",
          pollInterval: 1,
          pollLines: 8,
        }),
        tmux({ action: "list-polls" }, { delayMs: 4_500 }),
        reply(doneMarker),
      ],
      { waitFor: "multi-poll-04" },
    );

    expect(countOccurrences(result.pane, "tmux poll: poll-multi @")).toBeGreaterThanOrEqual(2);
    expect(result.pane).toContain("multi-poll-01");
    expect(result.pane).toContain("multi-poll-04");
    expect(result.pane).toContain(doneMarker);
  }, 30_000);

  it("triggers model turns for every model-delivered poll even when output is unchanged", async () => {
    const workspace = createWorkspace({
      pollDelivery: "model",
      minimumPollIntervalSeconds: 1,
    });
    const result = await runTui(
      workspace,
      [
        bash("printf 'model-poll-hello\\n'; sleep 5", {
          background: true,
          name: "poll-model",
          pollInterval: 1,
          pollLines: 5,
        }),
        reply("model-poll-turn-1"),
        reply("model-poll-turn-2"),
      ],
      { waitFor: "model-poll-turn-2" },
    );

    expect(result.pane).toContain("tmux poll: poll-model @");
    expect(result.pane).toContain("model-poll-hello");
    expect(result.pane).toContain("model-poll-turn-1");
    expect(result.pane).toContain("model-poll-turn-2");
  }, 30_000);

  it.each(bashOutputCases)(
    "renders $name bash output while collapsed",
    async (testCase) => {
      const result = await runBashCard(testCase.command);

      expect(stableBashTranscript(result.pane)).toBe(testCase.expectedTranscript);
    },
    30_000,
  );

  it("can capture ANSI-colored bash output", async () => {
    const workspace = createWorkspace();
    const command = "printf 'color-line\\n'";
    const result = await runTui(workspace, [bashTool(command), reply(doneMarker)], {
      captureAnsi: true,
    });
    const transcript = ansiBashTranscript(result.paneAnsi ?? "", doneMarker);

    expect(result.paneAnsi).toContain(String.fromCharCode(27));
    expect(paneLines(transcript).join("\n")).toContain(`$ printf 'color-line\\n'

color-line

Took`);
    expect(transcript).toMatch(ANSI_ESCAPE_PATTERN);
  }, 30_000);

  it("renders collapsed elision with the configured expand keybinding", async () => {
    const workspace = createWorkspace();
    writeFileSync(
      path.join(workspace.agentDir, "keybindings.json"),
      JSON.stringify({ "app.tools.expand": "ctrl+x" }, null, 2),
      "utf8",
    );

    const result = await runTui(workspace, [
      bashTool("for i in $(seq 1 8); do printf 'keymap-line-%03d\\n' \"$i\"; done"),
      reply(doneMarker),
    ]);
    const transcript = stableBashTranscript(result.pane);

    expect(transcript).toContain("... (3 earlier lines, ctrl+x to expand)");
    expect(transcript).not.toContain("ctrl+o to expand");
  }, 30_000);

  it.each(peekOutputCases)(
    "renders $name peek output while collapsed",
    async (testCase) => {
      const result = await runPeekCard(testCase);

      expect(stableTmuxToolTranscript(result.pane, "tmux peek @")).toBe(
        testCase.expectedTranscript,
      );
    },
    30_000,
  );

  it("expands collapsed overflowing peek output with ctrl-o", async () => {
    const workspace = createWorkspace();
    const command = "for i in $(seq 1 8); do printf 'peek-overflow-%03d\\n' \"$i\"; done; sleep 30";
    const result = await runTui(
      workspace,
      [
        bash(command, { background: true, name: "peek-overflow" }),
        tmuxForLatestWindow({ action: "peek" }, { delayMs: 500 }),
        reply(doneMarker),
      ],
      {
        checkpoints: [{ name: "collapsed", waitFor: doneMarker, keys: ["C-o"], delayMs: 300 }],
        waitFor: "peek-overflow-002",
      },
    );

    expect(stableTmuxToolTranscript(result.checkpoints.collapsed, "tmux peek @"))
      .toBe(`tmux peek @<id>
✓ tmux window: peek-overflow @<id>
 $ for i in $(seq 1 8); do printf 'peek-overflow-%03d\\n' "$i"; done; sleep 30
 ... (3 earlier lines, ctrl+o to expand)
 peek-overflow-004
 peek-overflow-005
 peek-overflow-006
 peek-overflow-007
 peek-overflow-008

 Attach with: tmux switch-client -t @<id>`);
    expect(stableTmuxToolTranscript(result.pane, "tmux peek @")).toBe(`tmux peek @<id>
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

  it.each(pollOutputCases)(
    "renders $name periodic poll output exactly",
    async (testCase) => {
      const result = await runPollCard(testCase);

      if (testCase.expectedActionTranscript !== undefined) {
        expect(stableTmuxToolTranscript(result.pane, "tmux poll @")).toBe(
          testCase.expectedActionTranscript,
        );
      }
      expect(stablePollMessageTranscript(result.pane, testCase.windowName)).toBe(
        testCase.expectedTranscript,
      );
    },
    30_000,
  );

  it("truncates long bash call titles", async () => {
    const workspace = createWorkspace();
    const command =
      "printf 'long-title-ok\\n'; printf 'abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz\\n' >/dev/null";
    const result = await runTui(workspace, [bash(command), reply(doneMarker)]);

    expect(result.pane).toContain(truncatedCommandTitle(command));
    expect(result.pane).toContain("long-title-ok");
  }, 30_000);
});
