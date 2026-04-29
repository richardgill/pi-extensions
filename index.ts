import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import files from "./extensions/files/index.js";
import preset from "./extensions/preset/index.js";
import subPi from "./extensions/sub-pi/index.js";
import subPiSkill from "./extensions/sub-pi-skill/index.js";

const extensions = [files, preset, subPi, subPiSkill];

export default (pi: ExtensionAPI): void => {
  for (const extension of extensions) extension(pi);
};
