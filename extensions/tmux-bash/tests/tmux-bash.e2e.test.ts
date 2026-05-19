import { afterEach, describe, expect, it } from "vitest";
import { createPiE2eProject, expectPiSuccess, type PiE2eProject } from "./testing/e2e-project.js";
import { bash, replyIfContextContains } from "./testing/scripted-provider.js";

const projects: PiE2eProject[] = [];

const createProject = (): PiE2eProject => {
  const project = createPiE2eProject();
  projects.push(project);
  return project;
};

afterEach(() => {
  projects.forEach((project) => project.cleanup());
  projects.length = 0;
});

describe("tmux-bash e2e", () => {
  it("runs echo hello through pi print mode", async () => {
    const project = createProject();

    const result = await project.run({
      script: [bash('echo "hello"'), replyIfContextContains("hello")],
      prompt: "run hello",
    });

    expectPiSuccess(result);
    expect(result.terminalOutput).toMatchInlineSnapshot(`"hello\n"`);
    expect(project.tmuxSessionExists()).toBe(false);
  }, 40_000);
});
