/**
 * Desktop Notification Extension
 *
 * Plays a beep sound when the agent finishes and is waiting for input.
 */

import { spawn } from "child_process";
import { homedir } from "os";
import { join } from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const beep = () => {
  spawn(join(homedir(), "Scripts", "beep"), { detached: true, stdio: "ignore" }).unref();
};

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async () => {
    beep();
  });
}
