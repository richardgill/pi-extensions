import { spawn } from "node:child_process";
import path from "node:path";

const buildPiArgs = (extensions: string[], prompt: string): string[] => [
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--offline",
  ...extensions.flatMap((extension) => ["-e", extension]),
  "--provider",
  "scripted",
  "--model",
  "scripted",
  "-p",
  prompt,
];

export type RunPiOptions = {
  cwd: string;
  agentDir: string;
  extensions: string[];
  prompt: string;
  timeoutMs?: number;
};

export type RunPiResult = {
  stdout: string;
  stderr: string;
  terminalOutput: string;
  code: number | null;
};

export const runPi = async (rawOptions: RunPiOptions): Promise<RunPiResult> => {
  const options = { ...rawOptions, timeoutMs: rawOptions.timeoutMs ?? 30_000 };

  const piBin = path.resolve("node_modules/.bin/pi");
  const args = buildPiArgs(options.extensions, options.prompt);

  return new Promise((resolve, reject) => {
    const child = spawn(piBin, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: options.agentDir,
        PI_EXTENSION_CONFIG_DIR: options.agentDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("pi timed out"));
    }, options.timeoutMs);
    let stdout = "";
    let stderr = "";
    const terminalChunks: string[] = [];

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      terminalChunks.push(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      terminalChunks.push(text);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr,
        terminalOutput: terminalChunks.join(""),
        code,
      });
    });
  });
};
