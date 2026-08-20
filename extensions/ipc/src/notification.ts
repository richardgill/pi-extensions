import {
  formatSize,
  truncateTail,
  type ExtensionAPI,
  type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { IpcConfig } from "./config";
import type { DelegateSettledEnvelope } from "./protocol";

export const MESSAGE_TYPE = "pi-ipc.delegate-settled";

type DelegateNotificationDetails = DelegateSettledEnvelope & {
  output: string;
};

const inspectionCommand = (config: IpcConfig, sessionId: string): string[] =>
  config.inspectionCommand.map((argument) => argument.replaceAll("{{childSessionId}}", sessionId));

const inspectionCommandLabel = (config: IpcConfig, sessionId: string): string =>
  inspectionCommand(config, sessionId)
    .map((argument) => JSON.stringify(argument))
    .join(" ");

export const truncatePiJqOutput = (
  output: string,
  sessionId: string,
  config: IpcConfig,
): string => {
  const truncation = truncateTail(output);
  const content = truncation.content.trimEnd() || "(no output)";
  if (!truncation.truncated) return content;

  return `${content}\n\n[Output truncated: showing last ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output: ${inspectionCommandLabel(config, sessionId)}]`;
};

export const inspectDelegate = async (
  pi: ExtensionAPI,
  envelope: DelegateSettledEnvelope,
  signal: AbortSignal,
  config: IpcConfig,
): Promise<DelegateNotificationDetails> => {
  try {
    const [command, ...args] = inspectionCommand(config, envelope.childSessionId);
    const result = await pi.exec(command!, args, { signal, timeout: config.inspectionTimeoutMs });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    if (result.code === 0 && !result.killed) {
      return { ...envelope, output: truncatePiJqOutput(output, envelope.childSessionId, config) };
    }
    const reason = result.killed
      ? "inspection command timed out"
      : `inspection command exited with code ${result.code}`;
    const details = truncatePiJqOutput(output, envelope.childSessionId, config);
    return {
      ...envelope,
      output: `${reason}${output ? `:\n\n${details}` : "."}\n\nInspect manually: ${inspectionCommandLabel(config, envelope.childSessionId)}`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ...envelope,
      output: `Could not run inspection command: ${reason}\n\nInspect manually: ${inspectionCommandLabel(config, envelope.childSessionId)}`,
    };
  }
};

export const notificationMessage = (
  envelope: DelegateSettledEnvelope,
  details: DelegateNotificationDetails,
  config: IpcConfig,
) => {
  return {
    customType: MESSAGE_TYPE,
    content: `Delegate ${envelope.taskSlug} (${envelope.childSessionId}) finished.\n\n${details.output}\n\n${config.supervisionPrompt}`,
    display: true,
    details,
  };
};

export const notificationRenderer: MessageRenderer<DelegateNotificationDetails> = (
  message,
  { outputPad },
  theme,
) => {
  const details = message.details!;
  const label = `${theme.fg("muted", "[")}${theme.fg("accent", details.taskSlug)}${theme.fg("muted", " finished]")}`;
  return new Text(`${label}\n\n${details.output}`, outputPad, 0);
};

export type { DelegateNotificationDetails };
