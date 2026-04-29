import { loadConfigOrDefault } from "@richardgill/pi-config";
import { fileCollector } from "@richardgill/pi-file-collector";
import { z } from "zod";

const RegexPatternSchema = z.object({
  regex: z.string(),
  flags: z.string().optional(),
});

const PathCaptureRuleSchema = z.discriminatedUnion("from", [
  z.object({ from: z.literal("positionals") }),
  z.object({ from: z.literal("positionalsAfter"), arg: z.string() }),
  z.object({ from: z.literal("lastPositional") }),
]);

const CaptureValueRuleSchema = z.object({
  from: z.literal("arg"),
  arg: z.string(),
});

const RangeCaptureRuleSchema = z.discriminatedUnion("from", [
  z.object({ from: z.literal("sedPrintScript"), arg: z.string() }),
  z.object({ from: z.literal("headLineCount"), option: z.string() }),
  z.object({ from: z.literal("tailLineCount"), option: z.string() }),
]);

const BashShimCommandSchema = z.object({
  name: z.string(),
  argv: z
    .object({
      valueOptions: z.array(z.string()).optional(),
      namedValueOptions: z.record(z.string(), z.string()).optional(),
      stopAtDoubleDash: z.boolean().optional(),
    })
    .optional(),
  capture: z.object({
    paths: PathCaptureRuleSchema,
    matchedText: CaptureValueRuleSchema.optional(),
    range: RangeCaptureRuleSchema.optional(),
  }),
});

const ConfigSchema = z.object({
  commandName: z.string().optional(),
  sidecarEnabled: z.boolean().optional(),
  sidecarFilename: z.string().optional(),
  collectReadTool: z.boolean().optional(),
  collectWriteTool: z.boolean().optional(),
  collectBashCommand: z.boolean().optional(),
  collectBashOutput: z.boolean().optional(),
  collectAssistantOutput: z.boolean().optional(),
  appendSystemPrompt: z.string().optional(),
  assistantCitationPatterns: z.array(RegexPatternSchema).optional(),
  bashOutputPatterns: z.array(RegexPatternSchema).optional(),
  bashShimCommands: z.array(BashShimCommandSchema).optional(),
});

const config = loadConfigOrDefault({ filename: "file-collector.jsonc", schema: ConfigSchema });

export default fileCollector(config);
