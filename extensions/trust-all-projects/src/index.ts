import type { ExtensionAPI, ProjectTrustEventResult } from "@earendil-works/pi-coding-agent";

const trustAllProjectsExtension = (pi: ExtensionAPI) => {
  pi.on(
    "project_trust",
    async (): Promise<ProjectTrustEventResult> => ({
      trusted: "yes",
      remember: true,
    }),
  );
};

export default trustAllProjectsExtension;
