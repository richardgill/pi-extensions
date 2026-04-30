import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig, loadConfigOrDefault, resolveOptions } from "../src/index.js";

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

describe("resolveOptions", () => {
  it("merges input over defaults", () => {
    expect(resolveOptions({ name: "pi", nested: { enabled: true } }, { nested: {} })).toEqual({
      name: "pi",
      nested: { enabled: true },
    });
  });

  it("preserves non-plain object defaults", () => {
    const regex = /abc/g;
    expect(resolveOptions({ regex }, {})).toEqual({ regex });
  });
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

  it("uses defaults when optional config is missing", () => {
    const folder = createTempDir();
    const schema = z.object({ value: z.string() });

    expect(
      loadConfigOrDefault({
        folder,
        filename: "missing.json",
        schema,
        defaults: { value: "fallback" },
      }),
    ).toEqual({ value: "fallback" });
  });

  it("merges defaults with partial optional config", () => {
    const folder = createTempDir();
    const schema = z.object({ value: z.string(), nested: z.object({ count: z.number() }) });
    writeConfig(folder, "partial.json", '{ "nested": { "count": 2 } }');

    expect(
      loadConfigOrDefault({
        folder,
        filename: "partial.json",
        schema,
        defaults: { value: "fallback", nested: { count: 1 } },
      }),
    ).toEqual({ value: "fallback", nested: { count: 2 } });
  });
});
