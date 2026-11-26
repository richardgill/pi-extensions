import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { hostname as localHostname } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";

export const piSessionStatusSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().min(1),
    sessionFile: z.string().min(1),
    streamId: z.string().min(1),
    processInstanceId: z.string().min(1),
    pid: z.number().int().positive(),
    hostname: z.string().min(1),
    tmuxPane: z.string().min(1).optional(),
    startedAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    state: z.enum(["idle", "busy", "stopped"]),
    model: z
      .object({
        provider: z.string().min(1),
        id: z.string().min(1),
        name: z.string().min(1),
      })
      .strict()
      .optional(),
    thinkingLevel: z.string().min(1),
    modelOptions: z
      .array(
        z
          .object({
            provider: z.string().min(1),
            id: z.string().min(1),
            name: z.string().min(1),
          })
          .strict(),
      )
      .max(256)
      .optional(),
    contextUsage: z
      .object({
        tokens: z.number().nonnegative(),
        contextWindow: z.number().positive(),
        percent: z.number().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type PiSessionStatus = z.infer<typeof piSessionStatusSchema>;
export type PiSessionStatusUpdate = Partial<
  Pick<PiSessionStatus, "contextUsage" | "model" | "modelOptions" | "state" | "thinkingLevel">
>;
export type PiSessionStatusWriter = {
  filePath: string;
  streamId: string;
  update: (update: PiSessionStatusUpdate) => Promise<void>;
  close: () => Promise<void>;
};
export type PiSessionStatusSource = {
  list: () => Promise<readonly PiSessionStatus[]>;
  subscribe: (invalidate: () => void, options: { signal: AbortSignal }) => () => void;
};

type StatusWriterState = {
  accepting: boolean;
  current: PiSessionStatus;
  filePath: string;
  onError?: (error: unknown) => void;
  sessionDir: string;
  writeChain: Promise<void>;
};

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;

const requirePathSegment = (value: string, label: string): string => {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new Error(`Invalid ${label} for Pi session status path`);
  }
  return value;
};

export const piSessionStatusPath = (rootDir: string, sessionId: string, streamId: string): string =>
  join(
    resolve(rootDir),
    requirePathSegment(sessionId, "session ID"),
    `${requirePathSegment(streamId, "stream ID")}.status.json`,
  );

export const parsePiSessionStatus = (value: unknown): PiSessionStatus | undefined => {
  const result = piSessionStatusSchema.safeParse(value);
  return result.success ? result.data : undefined;
};

const reportError = (onError: ((error: unknown) => void) | undefined, error: unknown): void => {
  try {
    onError?.(error);
  } catch {}
};

const replaceStatusFile = async (
  state: StatusWriterState,
  status: PiSessionStatus,
): Promise<void> => {
  await mkdir(state.sessionDir, { recursive: true, mode: 0o700 });
  const temporaryPath = `${state.filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(status)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, state.filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

const updateStatus = (state: StatusWriterState, update: PiSessionStatusUpdate): Promise<void> => {
  if (!state.accepting) {
    return state.writeChain;
  }
  const status = piSessionStatusSchema.parse({
    ...state.current,
    ...update,
    updatedAt: Date.now(),
  });
  state.current = status;
  const write = state.writeChain.then(() => replaceStatusFile(state, status));
  state.writeChain = write.catch((error: unknown) => reportError(state.onError, error));
  return state.writeChain;
};

export const createPiSessionStatusWriter = ({
  rootDir,
  status,
  onError,
}: {
  rootDir: string;
  status: Omit<PiSessionStatus, "updatedAt" | "version">;
  onError?: (error: unknown) => void;
}): PiSessionStatusWriter => {
  const filePath = piSessionStatusPath(rootDir, status.sessionId, status.streamId);
  const state: StatusWriterState = {
    accepting: true,
    current: piSessionStatusSchema.parse({
      ...status,
      updatedAt: status.startedAt,
      version: 1,
    }),
    filePath,
    onError,
    sessionDir: join(resolve(rootDir), status.sessionId),
    writeChain: Promise.resolve(),
  };

  return {
    filePath,
    streamId: status.streamId,
    update: (update) => updateStatus(state, update),
    close: async () => {
      if (!state.accepting) {
        await state.writeChain;
        return;
      }
      const closing = updateStatus(state, { state: "stopped" });
      state.accepting = false;
      await closing;
    },
  };
};

const readStatus = async (
  filePath: string,
  sessionId: string,
  streamId: string,
): Promise<PiSessionStatus | undefined> => {
  try {
    const status = parsePiSessionStatus(JSON.parse(await readFile(filePath, "utf8")));
    return status?.sessionId === sessionId && status.streamId === streamId ? status : undefined;
  } catch {
    return undefined;
  }
};

const compareRecency = (left: PiSessionStatus, right: PiSessionStatus): number =>
  left.updatedAt - right.updatedAt ||
  left.startedAt - right.startedAt ||
  left.streamId.localeCompare(right.streamId);

const newestBy = (
  statuses: readonly PiSessionStatus[],
  keyOf: (status: PiSessionStatus) => string,
): PiSessionStatus[] => {
  const newest = new Map<string, PiSessionStatus>();
  statuses.forEach((status) => {
    const key = keyOf(status);
    const previous = newest.get(key);
    if (!previous || compareRecency(previous, status) < 0) {
      newest.set(key, status);
    }
  });
  return [...newest.values()];
};

export const isLocalPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const listPiSessionStatuses = async ({
  rootDir,
  hostname = localHostname(),
  pidAlive = isLocalPidAlive,
}: {
  rootDir: string;
  hostname?: string;
  pidAlive?: (pid: number) => boolean;
}): Promise<PiSessionStatus[]> => {
  const sessionDirectories = (
    await readdir(resolve(rootDir), {
      withFileTypes: true,
    }).catch(() => [])
  )
    .filter((entry) => entry.isDirectory() && SAFE_PATH_SEGMENT.test(entry.name))
    .map((entry) => entry.name);
  const statuses = (
    await Promise.all(
      sessionDirectories.map(async (sessionId) => {
        const sessionDir = join(resolve(rootDir), sessionId);
        const files = (await readdir(sessionDir, { withFileTypes: true }).catch(() => [])).filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith(".status.json") &&
            SAFE_PATH_SEGMENT.test(entry.name.slice(0, -".status.json".length)),
        );
        return Promise.all(
          files.map((entry) => {
            const streamId = entry.name.slice(0, -".status.json".length);
            return readStatus(join(sessionDir, entry.name), sessionId, streamId);
          }),
        );
      }),
    )
  )
    .flatMap((values) => values)
    .filter((status) => status !== undefined);
  const processStatuses = newestBy(
    statuses,
    ({ hostname: statusHostname, processInstanceId }) => `${statusHostname}\0${processInstanceId}`,
  ).filter(
    (status) => status.state !== "stopped" && status.hostname === hostname && pidAlive(status.pid),
  );
  return newestBy(processStatuses, ({ sessionId }) => sessionId).sort((left, right) =>
    left.sessionId.localeCompare(right.sessionId),
  );
};

export const createPiSessionStatusSource = ({
  rootDir,
  pollIntervalMs = 250,
  hostname,
  pidAlive,
}: {
  rootDir: string;
  pollIntervalMs?: number;
  hostname?: string;
  pidAlive?: (pid: number) => boolean;
}): PiSessionStatusSource => ({
  list: () => listPiSessionStatuses({ rootDir, hostname, pidAlive }),
  subscribe: (invalidate, { signal }) => {
    if (signal.aborted) {
      return () => undefined;
    }
    let watcher: FSWatcher | undefined;
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    let fingerprint: string | undefined;
    let checkQueue = Promise.resolve();
    const check = () => {
      checkQueue = checkQueue
        .then(async () => {
          const next = JSON.stringify(await listPiSessionStatuses({ rootDir, hostname, pidAlive }));
          if (next === fingerprint || signal.aborted) {
            return;
          }
          fingerprint = next;
          invalidate();
        })
        .catch(() => undefined);
    };
    const schedule = () => {
      if (scheduled || signal.aborted) {
        return;
      }
      scheduled = setTimeout(() => {
        scheduled = undefined;
        check();
      }, 10);
      scheduled.unref();
    };
    try {
      watcher = watch(resolve(rootDir), { recursive: true }, schedule);
    } catch {}
    check();
    const timer = setInterval(schedule, pollIntervalMs);
    timer.unref();
    const dispose = () => {
      signal.removeEventListener("abort", dispose);
      if (scheduled) {
        clearTimeout(scheduled);
      }
      clearInterval(timer);
      watcher?.close();
    };
    signal.addEventListener("abort", dispose, { once: true });
    return dispose;
  },
});
