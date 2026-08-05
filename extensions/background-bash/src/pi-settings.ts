import { homedir } from "node:os";
import { join } from "node:path";
import {
  getAgentDir,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export type PiBashSettings = {
  shellPath?: string;
  commandPrefix?: string;
};

type TrustAwareContext = ExtensionContext & {
  isProjectTrusted?: () => boolean;
};

const isProjectTrusted = (ctx: ExtensionContext): boolean =>
  (ctx as TrustAwareContext).isProjectTrusted?.() ?? true;

const normalizeShellPath = (shellPath: string | undefined): string | undefined => {
  if (shellPath === "~") return homedir();
  if (shellPath?.startsWith("~/") || shellPath?.startsWith("~\\")) {
    return join(homedir(), shellPath.slice(2));
  }
  return shellPath;
};

export const resolvePiBashSettings = (ctx: ExtensionContext): PiBashSettings => {
  const trusted = isProjectTrusted(ctx);
  const settings = SettingsManager.create(trusted ? ctx.cwd : getAgentDir());
  if (trusted) {
    return {
      shellPath: normalizeShellPath(settings.getShellPath()),
      commandPrefix: settings.getShellCommandPrefix(),
    };
  }

  const global = settings.getGlobalSettings();
  return {
    shellPath: normalizeShellPath(global.shellPath),
    commandPrefix: global.shellCommandPrefix,
  };
};
