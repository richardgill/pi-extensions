import type { ExtensionAPI, ProjectTrustEventResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import trustAllProjects from "../src/index";

describe("trust all projects", () => {
  it("persists an affirmative trust decision", async () => {
    let handler: (() => Promise<ProjectTrustEventResult>) | undefined;
    const pi = {
      on: (_event: string, callback: typeof handler) => {
        handler = callback;
      },
    } as unknown as ExtensionAPI;

    trustAllProjects(pi);

    await expect(handler?.()).resolves.toEqual({ trusted: "yes", remember: true });
  });
});
