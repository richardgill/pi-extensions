import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTmuxBashConfig } from "../src/config";

const originalExtensionConfigDir = process.env.PI_EXTENSION_CONFIG_DIR;

const createTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "tmux-bash-config-"));

const restoreExtensionConfigDir = () => {
  if (originalExtensionConfigDir === undefined) {
    delete process.env.PI_EXTENSION_CONFIG_DIR;
    return;
  }

  process.env.PI_EXTENSION_CONFIG_DIR = originalExtensionConfigDir;
};

const writeTmuxBashConfig = (folder: string, config: object): void => {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "tmux-bash.jsonc"), JSON.stringify(config), "utf8");
};

afterEach(() => {
  restoreExtensionConfigDir();
});

describe("tmux-bash config", () => {
  it("rejects unknown template variables", () => {
    const folder = createTempDir();
    process.env.PI_EXTENSION_CONFIG_DIR = folder;
    writeTmuxBashConfig(folder, { bashToolDescription: "Use {{blah}}" });

    expect(() => loadTmuxBashConfig()).toThrow(
      'config.bashToolDescription uses unknown template variable "blah"',
    );
  });

  it("loads tmux environment export denylist config", () => {
    const folder = createTempDir();
    process.env.PI_EXTENSION_CONFIG_DIR = folder;
    writeTmuxBashConfig(folder, { tmuxEnvExportDenylist: ["CUSTOM"] });

    expect(loadTmuxBashConfig().tmuxEnvExportDenylist).toEqual(["CUSTOM"]);
  });

  it("loads foreground bash update interval config", () => {
    const folder = createTempDir();
    process.env.PI_EXTENSION_CONFIG_DIR = folder;
    writeTmuxBashConfig(folder, { foregroundBashUpdateIntervalMs: 100 });

    expect(loadTmuxBashConfig().foregroundBashUpdateIntervalMs).toBe(100);
  });

  it("loads default timeout action config", () => {
    const folder = createTempDir();
    process.env.PI_EXTENSION_CONFIG_DIR = folder;
    writeTmuxBashConfig(folder, { defaultTimeoutAction: "kill" });

    expect(loadTmuxBashConfig().defaultTimeoutAction).toBe("kill");
  });
});
