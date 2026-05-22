import { loadConfigOrDefault } from "@richardgill/pi-config";
import { DEFAULT_OPTIONS, fileCollector } from "@richardgill/pi-file-collector";
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
  filenameSuffix: z.string().default(DEFAULT_OPTIONS.filenameSuffix),
  collectReadTool: z.boolean().default(DEFAULT_OPTIONS.collectReadTool),
  collectWriteTool: z.boolean().default(DEFAULT_OPTIONS.collectWriteTool),
  collectEditTool: z.boolean().default(DEFAULT_OPTIONS.collectEditTool),
  collectBashCommand: z.boolean().default(DEFAULT_OPTIONS.collectBashCommand),
  collectBashOutput: z.boolean().default(DEFAULT_OPTIONS.collectBashOutput),
  collectAssistantOutput: z.boolean().default(DEFAULT_OPTIONS.collectAssistantOutput),
  appendSystemPrompt: z.string().default(DEFAULT_OPTIONS.appendSystemPrompt),
  assistantCitationPatterns: z
    .array(RegexPatternSchema)
    .default(() => structuredClone(DEFAULT_OPTIONS.assistantCitationPatterns)),
  bashOutputPatterns: z
    .array(RegexPatternSchema)
    .default(() => structuredClone(DEFAULT_OPTIONS.bashOutputPatterns)),
  bashShimCommands: z
    .array(BashShimCommandSchema)
    .default(() => structuredClone(DEFAULT_OPTIONS.bashShimCommands)),
});

const config = loadConfigOrDefault({
  filename: "file-collector.jsonc",
  schema: ConfigSchema,
});

export default fileCollector(config);
