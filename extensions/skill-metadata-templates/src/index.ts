import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfigOrDefault } from "@richardgill/pi-config";

import { skillMetadataTemplates, SkillMetadataTemplatesConfigSchema } from "./extension";

const configDir = process.env.PI_EXTENSION_CONFIG_DIR ?? getAgentDir();
const config = loadConfigOrDefault({
  folder: configDir,
  filename: "skill-metadata-templates.jsonc",
  schema: SkillMetadataTemplatesConfigSchema,
});

export default skillMetadataTemplates(config, { templateBaseDir: configDir });
