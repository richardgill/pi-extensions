import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_OPTIONS, loadParrotConfig } from "../src/config";

const originalExtensionConfigDir = process.env.PI_EXTENSION_CONFIG_DIR;

const createTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "parrot-config-"));

const restoreExtensionConfigDir = () => {
  if (originalExtensionConfigDir === undefined) {
    delete process.env.PI_EXTENSION_CONFIG_DIR;
    return;
  }

  process.env.PI_EXTENSION_CONFIG_DIR = originalExtensionConfigDir;
};

const writeParrotConfig = (folder: string, config: object): void => {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "parrot.jsonc"), JSON.stringify(config), "utf8");
};

afterEach(() => {
  restoreExtensionConfigDir();
});

describe("parrot config", () => {
  it("loads defaults when config is missing", () => {
    process.env.PI_EXTENSION_CONFIG_DIR = createTempDir();

    expect(loadParrotConfig()).toEqual(DEFAULT_OPTIONS);
  });

  it("loads keyboard shortcut config", () => {
    const folder = createTempDir();
    process.env.PI_EXTENSION_CONFIG_DIR = folder;
    writeParrotConfig(folder, { keyboardShortcut: "ctrl+r" });

    expect(loadParrotConfig().keyboardShortcut).toBe("ctrl+r");
  });

  it("can disable the keyboard shortcut", () => {
    const folder = createTempDir();
    process.env.PI_EXTENSION_CONFIG_DIR = folder;
    writeParrotConfig(folder, { keyboardShortcut: false });

    expect(loadParrotConfig().keyboardShortcut).toBe(false);
  });
});
