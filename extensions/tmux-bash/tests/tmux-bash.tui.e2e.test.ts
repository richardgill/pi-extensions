import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiE2eProject, type PiE2eProject } from "./testing/e2e-project.js";
import {
  bash,
  reply,
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
    expect(result.pane).toMatch(/Took [0-9]+s/);
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

  it("expands collapsed tool output with ctrl-o", async () => {
    const project = createProject();
    const result = await runTui(
      project,
      [
        bash("for i in $(seq 1 8); do printf 'expand-line-%03d\\n' \"$i\"; done"),
        reply(doneMarker),
      ],
      {
        checkpoints: [{ name: "collapsed", waitFor: doneMarker, keys: ["C-o"], delayMs: 300 }],
        waitFor: "[Full output:",
      },
    );

    expect(result.checkpoints.collapsed).toContain("expand-line-008");
    expect(result.checkpoints.collapsed).not.toContain("[Full output:");
    expect(result.pane).toContain("expand-line-008");
    expect(result.pane).toContain("[Full output:");
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
