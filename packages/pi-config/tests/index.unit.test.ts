import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfigOrDefault, resolveOptions, templatedString } from "../src/index.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalExtensionConfigDir = process.env.PI_EXTENSION_CONFIG_DIR;

const createTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-"));

const writeConfig = (folder: string, filename: string, content: string) => {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, filename), content, "utf8");
};

const restoreEnv = (name: string, value: string | undefined) => {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
};

afterEach(() => {
  restoreEnv("PI_CODING_AGENT_DIR", originalAgentDir);
  restoreEnv("PI_EXTENSION_CONFIG_DIR", originalExtensionConfigDir);
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

describe("templatedString", () => {
  it("renders declared variables", () => {
    const folder = createTempDir();
    const schema = z.object({
      defaultTimeoutSeconds: z.number(),
      maxTimeoutSeconds: z.number(),
      prompt: templatedString({ variables: ["defaultTimeoutSeconds", "maxTimeoutSeconds"] }),
    });
    writeConfig(
      folder,
      "template.json",
      '{ "defaultTimeoutSeconds": 10, "maxTimeoutSeconds": 20, "prompt": "default {{ defaultTimeoutSeconds }}s, max {{maxTimeoutSeconds}}s" }',
    );

    expect(
      loadConfigOrDefault({ folder, filename: "template.json", schema, defaults: {} }),
    ).toEqual({
      defaultTimeoutSeconds: 10,
      maxTimeoutSeconds: 20,
      prompt: "default 10s, max 20s",
    });
  });

  it("rejects undeclared variables", () => {
    const folder = createTempDir();
    const schema = z.object({ prompt: templatedString({ variables: ["maxTimeoutSeconds"] }) });
    writeConfig(folder, "unknown-template.json", '{ "prompt": "max {{timeoutMax}}s" }');

    expect(() =>
      loadConfigOrDefault({ folder, filename: "unknown-template.json", schema, defaults: {} }),
    ).toThrow('config.prompt uses unknown template variable "timeoutMax"');
  });

  it("rejects missing variables by default", () => {
    const folder = createTempDir();
    const schema = z.object({ prompt: templatedString({ variables: ["maxTimeoutSeconds"] }) });
    writeConfig(folder, "missing-template.json", '{ "prompt": "max {{maxTimeoutSeconds}}s" }');

    expect(() =>
      loadConfigOrDefault({ folder, filename: "missing-template.json", schema, defaults: {} }),
    ).toThrow('config.prompt uses missing template variable "maxTimeoutSeconds"');
  });

  it("keeps missing variables when configured", () => {
    const folder = createTempDir();
    const schema = z.object({
      prompt: templatedString({ missing: "keep", variables: ["maxTimeoutSeconds"] }),
    });
    writeConfig(folder, "keep-template.json", '{ "prompt": "max {{maxTimeoutSeconds}}s" }');

    expect(
      loadConfigOrDefault({ folder, filename: "keep-template.json", schema, defaults: {} }),
    ).toEqual({
      prompt: "max {{maxTimeoutSeconds}}s",
    });
  });

  it("rejects malformed templates", () => {
    const folder = createTempDir();
    const schema = z.object({ prompt: templatedString({ variables: ["maxTimeoutSeconds"] }) });
    writeConfig(folder, "malformed-template.json", '{ "prompt": "max {{maxTimeoutSeconds}s" }');

    expect(() =>
      loadConfigOrDefault({ folder, filename: "malformed-template.json", schema, defaults: {} }),
    ).toThrow('config.prompt has unclosed template open "{{"');
  });

  it("rejects triple-brace templates", () => {
    const folder = createTempDir();
    const schema = z.object({ prompt: templatedString({ variables: ["maxTimeoutSeconds"] }) });
    writeConfig(folder, "triple-template.json", '{ "prompt": "max {{{maxTimeoutSeconds}}}" }');

    expect(() =>
      loadConfigOrDefault({ folder, filename: "triple-template.json", schema, defaults: {} }),
    ).toThrow("config.prompt has a malformed template variable");
  });

  it("rejects unsupported variable value types", () => {
    const folder = createTempDir();
    const schema = z.object({
      limits: z.object({ max: z.number() }),
      prompt: templatedString({ variables: ["limits"] }),
    });
    writeConfig(
      folder,
      "object-template.json",
      '{ "limits": { "max": 20 }, "prompt": "limits {{limits}}" }',
    );

    expect(() =>
      loadConfigOrDefault({ folder, filename: "object-template.json", schema, defaults: {} }),
    ).toThrow('config.prompt uses unsupported template value "limits"');
  });
});

describe("loadConfigOrDefault", () => {
  it("loads JSONC and returns the schema output type", () => {
    const folder = createTempDir();
    const schema = z.object({ enabled: z.boolean(), names: z.array(z.string()) });
    writeConfig(
      folder,
      "example.json",
      '{\n  // comment\n  "enabled": true,\n  "names": ["a", "b"],\n}\n',
    );

    const config = loadConfigOrDefault({ folder, filename: "example.json", schema, defaults: {} });

    expect(config).toEqual({ enabled: true, names: ["a", "b"] });
  });

  it("defaults to the pi agent folder", () => {
    const folder = createTempDir();
    delete process.env.PI_EXTENSION_CONFIG_DIR;
    process.env.PI_CODING_AGENT_DIR = folder;
    const schema = z.object({ value: z.string() });
    writeConfig(folder, "default.json", '{ "value": "from-agent-dir" }');

    expect(loadConfigOrDefault({ filename: "default.json", schema, defaults: {} })).toEqual({
      value: "from-agent-dir",
    });
  });

  it("resolves explicit folder over extension config env over pi agent folder", () => {
    const explicitFolder = createTempDir();
    const extensionFolder = createTempDir();
    const agentFolder = createTempDir();
    const filename = "precedence.json";
    const schema = z.object({ value: z.string() });
    process.env.PI_EXTENSION_CONFIG_DIR = extensionFolder;
    process.env.PI_CODING_AGENT_DIR = agentFolder;
    writeConfig(agentFolder, filename, '{ "value": "agent" }');
    writeConfig(extensionFolder, filename, '{ "value": "extension" }');
    writeConfig(explicitFolder, filename, '{ "value": "explicit" }');

    expect(loadConfigOrDefault({ filename, schema, defaults: {} })).toEqual({ value: "extension" });
    expect(loadConfigOrDefault({ folder: explicitFolder, filename, schema, defaults: {} })).toEqual(
      {
        value: "explicit",
      },
    );
  });

  it("throws with the config path for invalid JSONC", () => {
    const folder = createTempDir();
    const schema = z.object({ value: z.string() });
    writeConfig(folder, "broken.json", '{ "value": }');

    expect(() =>
      loadConfigOrDefault({ folder, filename: "broken.json", schema, defaults: {} }),
    ).toThrow(/Invalid JSONC .*broken\.json:1:/);
  });

  it("throws with the config path for schema errors", () => {
    const folder = createTempDir();
    const schema = z.object({ value: z.string() });
    writeConfig(folder, "invalid.json", '{ "value": 123 }');

    expect(() =>
      loadConfigOrDefault({ folder, filename: "invalid.json", schema, defaults: {} }),
    ).toThrow(/Invalid config .*invalid\.json/);
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

  it("renders templated string fields after merging defaults", () => {
    const folder = createTempDir();
    const schema = z.object({
      defaultTimeoutSeconds: z.number(),
      maxTimeoutSeconds: z.number(),
      prompt: templatedString({ variables: ["defaultTimeoutSeconds", "maxTimeoutSeconds"] }),
    });
    writeConfig(folder, "template.json", '{ "maxTimeoutSeconds": 20 }');

    expect(
      loadConfigOrDefault({
        folder,
        filename: "template.json",
        schema,
        defaults: {
          defaultTimeoutSeconds: 10,
          maxTimeoutSeconds: 60,
          prompt: "default {{defaultTimeoutSeconds}}s, max {{ maxTimeoutSeconds }}s",
        },
        renderTemplates: true,
      }),
    ).toEqual({
      defaultTimeoutSeconds: 10,
      maxTimeoutSeconds: 20,
      prompt: "default 10s, max 20s",
    });
  });

  it("renders templated string fields by default", () => {
    const folder = createTempDir();
    const schema = z.object({
      value: z.number(),
      prompt: templatedString({ variables: ["value"] }),
    });
    writeConfig(folder, "template-default.json", '{ "value": 2, "prompt": "value {{value}}" }');

    expect(
      loadConfigOrDefault({
        folder,
        filename: "template-default.json",
        schema,
        defaults: {},
      }),
    ).toEqual({ value: 2, prompt: "value 2" });
  });

  it("does not render templated string fields when disabled", () => {
    const folder = createTempDir();
    const schema = z.object({
      value: z.number(),
      prompt: templatedString({ variables: ["value"] }),
    });
    writeConfig(folder, "template-disabled.json", '{ "value": 2, "prompt": "value {{value}}" }');

    expect(
      loadConfigOrDefault({
        folder,
        filename: "template-disabled.json",
        schema,
        defaults: {},
        renderTemplates: false,
      }),
    ).toEqual({ value: 2, prompt: "value {{value}}" });
  });

  it("renders optional templated string fields", () => {
    const folder = createTempDir();
    const schema = z.object({
      value: z.number(),
      prompt: templatedString({ variables: ["value"] }).optional(),
    });
    writeConfig(folder, "optional-template.json", '{ "value": 2, "prompt": "value {{value}}" }');

    expect(
      loadConfigOrDefault({
        folder,
        filename: "optional-template.json",
        schema,
        defaults: {},
        renderTemplates: true,
      }),
    ).toEqual({ value: 2, prompt: "value 2" });
  });

  it("validates rendered template output", () => {
    const folder = createTempDir();
    const schema = z.object({
      value: z.string(),
      prompt: templatedString({ variables: ["value"] }).min(6),
    });
    writeConfig(
      folder,
      "invalid-rendered-template.json",
      '{ "value": "x", "prompt": "{{value}}" }',
    );

    expect(() =>
      loadConfigOrDefault({
        folder,
        filename: "invalid-rendered-template.json",
        schema,
        defaults: {},
      }),
    ).toThrow(/Invalid config .*invalid-rendered-template\.json/);
  });

  it("does not run schema transforms twice when rendering templates", () => {
    const folder = createTempDir();
    let transformCount = 0;
    const schema = z.object({
      value: z.string().transform((value) => {
        transformCount += 1;
        return value;
      }),
      prompt: templatedString({ variables: ["value"] }),
    });
    writeConfig(folder, "transform-template.json", '{ "value": "x", "prompt": "{{value}}" }');

    expect(
      loadConfigOrDefault({
        folder,
        filename: "transform-template.json",
        schema,
        defaults: {},
      }),
    ).toEqual({ value: "x", prompt: "x" });
    expect(transformCount).toBe(1);
  });
});
