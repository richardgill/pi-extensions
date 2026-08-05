import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_OPTIONS, loadBackgroundBashConfig, resolveOptions } from "../src/config";

const tempDirs: string[] = [];
const originalConfigDir = process.env.PI_EXTENSION_CONFIG_DIR;

const createConfig = async (value: object): Promise<void> => {
  const folder = join(tmpdir(), `background-bash-config-${crypto.randomUUID()}`);
  tempDirs.push(folder);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "background-bash.jsonc"), JSON.stringify(value), "utf8");
  process.env.PI_EXTENSION_CONFIG_DIR = folder;
};

afterEach(async () => {
  if (originalConfigDir === undefined)
    Reflect.deleteProperty(process.env, "PI_EXTENSION_CONFIG_DIR");
  else process.env.PI_EXTENSION_CONFIG_DIR = originalConfigDir;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("background bash config", () => {
  it("resolves defaults and prompt templates", () => {
    expect(DEFAULT_OPTIONS.defaultTimeoutSeconds).toBe(30);
    expect(DEFAULT_OPTIONS.defaultTimeoutAction).toBe("background");
    expect(DEFAULT_OPTIONS.bashToolDescription).toContain("Defaults to a 30s timeout, max 60s");
    expect(DEFAULT_OPTIONS.systemPromptGuidelines[3]).toContain("bash_process list/peek/kill");
  });

  it("rejects an invalid timeout ordering", () => {
    expect(() => resolveOptions({ defaultTimeoutSeconds: 61, maxTimeoutSeconds: 60 })).toThrow(
      "defaultTimeoutSeconds must be less than or equal to maxTimeoutSeconds",
    );
  });

  it("loads JSONC and renders configured templates", async () => {
    await createConfig({
      defaultTimeoutSeconds: 12,
      bashToolName: "shell",
      processToolDescription: "Control {{bashToolName}} up to {{maxTimeoutSeconds}}s",
    });

    const config = loadBackgroundBashConfig();

    expect(config.processToolDescription).toBe("Control shell up to 60s");
  });
});
