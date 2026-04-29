import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig, loadConfigOrDefault } from "../src/index.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

const createTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-"));

const writeConfig = (folder: string, filename: string, content: string) => {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, filename), content, "utf8");
};

afterEach(() => {
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
    return;
  }

  process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

describe("loadConfig", () => {
  it("loads JSONC and returns the schema output type", () => {
    const folder = createTempDir();
    const schema = z.object({ enabled: z.boolean(), names: z.array(z.string()) });
    writeConfig(
      folder,
      "example.json",
      '{\n  // comment\n  "enabled": true,\n  "names": ["a", "b"],\n}\n',
    );

    const config = loadConfig({ folder, filename: "example.json", schema });

    expect(config).toEqual({ enabled: true, names: ["a", "b"] });
  });

  it("defaults to the pi agent folder", () => {
    const folder = createTempDir();
    process.env.PI_CODING_AGENT_DIR = folder;
    const schema = z.object({ value: z.string() });
    writeConfig(folder, "default.json", '{ "value": "from-agent-dir" }');

    expect(loadConfig({ filename: "default.json", schema })).toEqual({ value: "from-agent-dir" });
  });

  it("throws with the config path for invalid JSONC", () => {
    const folder = createTempDir();
    const schema = z.object({ value: z.string() });
    writeConfig(folder, "broken.json", '{ "value": }');

    expect(() => loadConfig({ folder, filename: "broken.json", schema })).toThrow(
      /Invalid JSONC .*broken\.json:1:/,
    );
  });

  it("throws with the config path for schema errors", () => {
    const folder = createTempDir();
    const schema = z.object({ value: z.string() });
    writeConfig(folder, "invalid.json", '{ "value": 123 }');

    expect(() => loadConfig({ folder, filename: "invalid.json", schema })).toThrow(
      /Invalid config .*invalid\.json/,
    );
  });

  it("uses the default value when optional config is missing", () => {
    const folder = createTempDir();
    const schema = z.object({ value: z.string().default("fallback") });

    expect(loadConfigOrDefault({ folder, filename: "missing.json", schema })).toEqual({
      value: "fallback",
    });
  });
});
