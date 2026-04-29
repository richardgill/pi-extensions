import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const validTestSuffixes = [".unit.test.ts", ".integration.test.ts", ".e2e.test.ts"];

const findEntryFiles = async (dir: string, entry: Dirent): Promise<string[]> => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? findFiles(path) : [path];
};

const findFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => findEntryFiles(dir, entry)));
  return nested.flat();
};

const findInvalidTestFiles = async () => {
  const files = await findFiles("extensions");
  return files
    .filter((file) => file.endsWith(".test.ts"))
    .filter((file) => !validTestSuffixes.some((suffix) => file.endsWith(suffix)))
    .sort();
};

const checkTestNaming = async () => {
  const invalidFiles = await findInvalidTestFiles();

  if (invalidFiles.length === 0) {
    console.log("✓ All test files use valid naming conventions");
    return true;
  }

  console.error(
    `✗ Found invalid test file names:\n${invalidFiles.map((file) => `  ${file}`).join("\n")}`,
  );
  return false;
};

const main = async () => {
  const testNamingPassed = await checkTestNaming();

  if (!testNamingPassed) {
    process.exit(1);
  }

  console.log("✓ All miscellaneous checks passed");
};

void main();
