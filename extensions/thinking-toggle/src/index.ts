import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const thinkingLevels = ["medium", "high", "xhigh"] as const;

const toggleThinkingLevel = (pi: ExtensionAPI) => {
  const currentIndex = thinkingLevels.findIndex((level) => level === pi.getThinkingLevel());
  const next = thinkingLevels[(currentIndex + 1) % thinkingLevels.length];
  pi.setThinkingLevel(next);
  return next;
};

export default function (pi: ExtensionAPI) {
  pi.registerShortcut("shift+tab", {
    description: "Cycle thinking medium/high/xhigh",
    handler: (ctx) => {
      const level = toggleThinkingLevel(pi);
      ctx.ui.notify(`Thinking level: ${level}`, "info");
    },
  });

  pi.registerCommand("toggle-thinking", {
    description: "Cycle thinking between medium, high, and xhigh",
    handler: async (_args, ctx) => {
      const level = toggleThinkingLevel(pi);
      ctx.ui.notify(`Thinking level: ${level}`, "info");
    },
  });
}
