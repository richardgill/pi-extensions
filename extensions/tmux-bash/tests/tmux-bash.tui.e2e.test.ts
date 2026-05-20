import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiE2eProject, type PiE2eProject } from "./testing/e2e-project.js";
import {
  bash,
  reply,
  type ScriptedStep,
  writeScriptedProvider,
} from "./testing/scripted-provider.js";
import { runPiTui } from "./testing/tui-pi.js";

const projects: PiE2eProject[] = [];
const doneMarker = "PI-TUI-DONE";

const createProject = (): PiE2eProject => {
  const project = createPiE2eProject();
  projects.push(project);
  return project;
};

const runTui = (project: PiE2eProject, script: ScriptedStep[]): Promise<{ pane: string }> => {
  const scriptedProvider = writeScriptedProvider(project.tempRoot, script);

  return runPiTui({
    cwd: project.projectDir,
    agentDir: project.agentDir,
    extensions: [path.resolve("extensions/tmux-bash/src/index.ts"), scriptedProvider],
    prompt: "run scripted tool call",
    waitFor: doneMarker,
    timeoutMs: 25_000,
  });
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
    expect(result.pane).toContain("Started in background tmux window.");
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
    expect(result.pane).toContain("Command is still running after 1 seconds");
    expect(result.pane).not.toContain("$ printf starting && sleep 5 (background)");
  }, 30_000);
});
