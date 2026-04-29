import { loadConfigOrDefault } from "@richardgill/pi-config";
import { subPiSkill } from "@richardgill/pi-sub-pi-skill";
import { z } from "zod";

const ConfigSchema = z.object({
  toolName: z.string().optional(),
});

const config = loadConfigOrDefault({ filename: "sub-pi-skill.jsonc", schema: ConfigSchema });

export default subPiSkill(config);
