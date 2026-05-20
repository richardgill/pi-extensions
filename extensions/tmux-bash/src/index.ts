import { loadTmuxBashConfig } from "./config.js";
import { tmuxBash } from "./extension.js";

export default tmuxBash(loadTmuxBashConfig());
