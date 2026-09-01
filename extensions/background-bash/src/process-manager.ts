import { constants as fsConstants, createWriteStream, type WriteStream } from "node:fs";
import { access, chmod, mkdir, rm } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { resolve } from "node:path";
import { finished } from "node:stream/promises";
import { spawn, type ChildProcess } from "node:child_process";
import {
  getShellConfig,
  type AgentToolResult,
  type BashOperations,
  type BashToolDetails,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "./config";
import type { PiBashSettings } from "./pi-settings";

export type BackgroundBashDetails = BashToolDetails & {
  pgid?: number;
  active?: boolean;
};

export type ProcessOutcome =
  | { result: AgentToolResult<BackgroundBashDetails | undefined>; error?: undefined }
  | { result?: undefined; error: Error };

export type ManagedProcess = {
  pgid: number;
  command: string;
  name?: string;
  startedAt: number;
  logPath: string;
  controller: AbortController;
  notifyOnExit: boolean;
  exitCode?: number;
  latest?: AgentToolResult<BackgroundBashDetails | undefined>;
  completion?: Promise<ProcessOutcome>;
  settlement: Promise<void>;
  detachAbort: () => void;
};

type ProcessMetadata = {
  command: string;
  name?: string;
  controller: AbortController;
  env: NodeJS.ProcessEnv;
  onData: (data: Buffer) => void;
  detachAbort: () => void;
};

type Deferred<Value> = {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
  reject: (error: unknown) => void;
};

type PreparedExecution = {
  operations: BashOperations;
  spawned: Promise<ManagedProcess>;
};

const deferred = <Value>(): Deferred<Value> => {
  let resolvePromise!: (value: Value) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

const signalExitCode = (signal: NodeJS.Signals | null): number | undefined => {
  if (!signal) return undefined;
  const number = osConstants.signals[signal];
  return number === undefined ? undefined : 128 + number;
};

const waitForChild = (
  child: ChildProcess,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> =>
  new Promise((resolveChild, rejectChild) => {
    child.once("error", rejectChild);
    child.once("close", (exitCode, signal) => resolveChild({ exitCode, signal }));
  });

const killProcessGroup = (pgid: number): void => {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
};

const cleanupProcessGroupAfterExit = (pgid: number): void => {
  try {
    killProcessGroup(pgid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  }
};

export class ProcessManager {
  readonly processes = new Map<number, ManagedProcess>();
  private runDir: string | undefined;
  private bashSettings: PiBashSettings = {};
  private shuttingDown = false;
  private readonly onHostExit = () => {
    this.processes.forEach((managed) => {
      try {
        killProcessGroup(managed.pgid);
      } catch {
        return;
      }
    });
  };

  constructor(
    private readonly options: ResolvedOptions,
    private readonly onBackgroundCountChange: (count: number) => void,
  ) {}

  initialize = async (
    sessionId: string,
    cwd: string,
    bashSettings: PiBashSettings,
  ): Promise<void> => {
    this.shuttingDown = false;
    this.bashSettings = bashSettings;
    const runName = `${encodeURIComponent(sessionId)}-${process.pid}-${Date.now().toString(36)}`;
    this.runDir = resolve(cwd, this.options.outputDir, runName);
    await mkdir(this.runDir, { recursive: true, mode: 0o700 });
    await chmod(this.runDir, 0o700);
    process.removeListener("exit", this.onHostExit);
    process.once("exit", this.onHostExit);
  };

  getCommandPrefix = (): string | undefined => this.bashSettings.commandPrefix;

  prepare = (metadata: ProcessMetadata): PreparedExecution => {
    const spawned = deferred<ManagedProcess>();
    const operations: BashOperations = {
      exec: async (command, cwd, options) => {
        try {
          return await this.spawnProcess(
            command,
            cwd,
            { ...options, onData: metadata.onData },
            metadata,
            spawned,
          );
        } catch (error) {
          spawned.reject(error);
          throw error;
        }
      },
    };
    return { operations, spawned: spawned.promise };
  };

  handoff = (
    managed: ManagedProcess,
    notify: (managed: ManagedProcess, outcome: ProcessOutcome) => void,
  ): void => {
    managed.notifyOnExit = true;
    managed.detachAbort();
    const completion = managed.completion;
    if (!completion) throw new Error(`Process ${managed.pgid} has no completion promise`);

    this.emitBackgroundCount();
    void completion.then((outcome) => {
      try {
        if (managed.notifyOnExit && !this.shuttingDown) notify(managed, outcome);
      } finally {
        this.processes.delete(managed.pgid);
        this.emitBackgroundCount();
      }
    });
  };

  finishForeground = (managed: ManagedProcess): void => {
    managed.detachAbort();
    this.processes.delete(managed.pgid);
  };

  kill = async (pgid: number): Promise<{ managed: ManagedProcess; outcome: ProcessOutcome }> => {
    const managed = this.processes.get(pgid);
    if (!managed?.notifyOnExit) {
      throw new Error(`No active background process with PGID ${pgid}`);
    }

    managed.notifyOnExit = false;
    this.emitBackgroundCount();
    managed.detachAbort();
    managed.controller.abort();
    const outcome = managed.completion
      ? await managed.completion
      : { error: new Error("Process stopped before command execution was ready") };
    this.processes.delete(pgid);
    return { managed, outcome };
  };

  shutdown = async (): Promise<void> => {
    this.shuttingDown = true;
    const active = [...this.processes.values()];
    active.forEach((managed) => {
      managed.notifyOnExit = false;
      managed.detachAbort();
      managed.controller.abort();
    });
    this.emitBackgroundCount();
    await Promise.allSettled(active.map((managed) => managed.completion ?? managed.settlement));
    this.processes.clear();
    if (!this.options.preserveOutputFiles && this.runDir) {
      await rm(this.runDir, { recursive: true, force: true });
    }
    this.runDir = undefined;
    this.bashSettings = {};
    process.removeListener("exit", this.onHostExit);
  };

  private emitBackgroundCount = (): void => {
    const count = [...this.processes.values()].filter((managed) => managed.notifyOnExit).length;
    this.onBackgroundCountChange(count);
  };

  private spawnProcess = async (
    command: string,
    cwd: string,
    options: Parameters<BashOperations["exec"]>[2],
    metadata: ProcessMetadata,
    spawned: Deferred<ManagedProcess>,
  ): Promise<{ exitCode: number | null }> => {
    if (this.shuttingDown) throw new Error("Background bash is shutting down");
    if (options.signal?.aborted) throw new Error("aborted");
    const runDir = this.runDir;
    if (!runDir) throw new Error("Background bash is not initialized");
    try {
      await access(cwd, fsConstants.F_OK);
    } catch {
      throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
    }

    const { shell, args } = getShellConfig(this.bashSettings.shellPath);
    const child = spawn(shell, [...args, command], {
      cwd,
      detached: true,
      env: { ...options.env, ...metadata.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (!child.pid) {
      const error = await new Promise<Error>((resolveError) => child.once("error", resolveError));
      throw error;
    }

    const pgid = child.pid;
    const childSettlement = waitForChild(child);
    child.once("exit", () => cleanupProcessGroupAfterExit(pgid));
    const onAbort = () => killProcessGroup(pgid);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const logPath = resolve(runDir, `${pgid}.log`);
    const log = createWriteStream(logPath, { flags: "w", mode: 0o600 });
    let timedOut = false;
    const timeoutHandle = options.timeout
      ? setTimeout(() => {
          timedOut = true;
          killProcessGroup(pgid);
        }, options.timeout * 1000)
      : undefined;
    const settlement = this.collectProcessOutput({
      child,
      childSettlement,
      log,
      onData: options.onData,
    });
    const managed: ManagedProcess = {
      pgid,
      command: metadata.command,
      name: metadata.name,
      startedAt: Date.now(),
      logPath,
      controller: metadata.controller,
      notifyOnExit: false,
      settlement: settlement.then(
        () => undefined,
        () => undefined,
      ),
      detachAbort: metadata.detachAbort,
    };
    this.processes.set(pgid, managed);
    spawned.resolve(managed);

    try {
      const result = await settlement;
      managed.exitCode = result.exitCode ?? signalExitCode(result.signal) ?? 1;
      if (options.signal?.aborted) throw new Error("aborted");
      if (timedOut) throw new Error(`timeout:${options.timeout}`);
      return { exitCode: managed.exitCode };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", onAbort);
    }
  };

  private collectProcessOutput = async ({
    child,
    childSettlement,
    log,
    onData,
  }: {
    child: ChildProcess;
    childSettlement: ReturnType<typeof waitForChild>;
    log: WriteStream;
    onData: (data: Buffer) => void;
  }): ReturnType<typeof waitForChild> => {
    const logSettlement = finished(log);
    void logSettlement.catch(() => undefined);
    let paused = false;
    const resumeOutput = () => {
      paused = false;
      child.stdout?.resume();
      child.stderr?.resume();
    };
    const handleData = (data: Buffer) => {
      const canContinue = log.write(data);
      onData(data);
      if (canContinue || paused) return;
      paused = true;
      child.stdout?.pause();
      child.stderr?.pause();
      log.once("drain", resumeOutput);
    };
    child.stdout?.on("data", handleData);
    child.stderr?.on("data", handleData);
    log.once("error", () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (child.pid) killProcessGroup(child.pid);
    });

    try {
      const result = await childSettlement;
      log.end();
      await logSettlement;
      return result;
    } catch (error) {
      if (child.pid) killProcessGroup(child.pid);
      log.destroy();
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      log.off("drain", resumeOutput);
    }
  };
}
