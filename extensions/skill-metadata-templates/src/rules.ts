import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

const ScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const PositionSchema = z.enum(["top", "bottom", "replace"]);
const SessionBranchSchema = z.literal("previousTurn");
const WhenSchema = z
  .object({
    metadata: z.record(z.string().trim().min(1), ScalarSchema).default({}),
    environment: z.record(z.string().trim().min(1), z.union([z.string(), z.null()])).default({}),
  })
  .strict();
const RuleSchema = z
  .object({
    name: z.string().trim().min(1),
    when: WhenSchema,
    position: PositionSchema.default("bottom"),
    sessionBranch: SessionBranchSchema.optional(),
    template: z.string().optional(),
    templateFile: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((rule) => (rule.template !== undefined) !== (rule.templateFile !== undefined), {
    message: "exactly one of template or templateFile is required",
  });

export const SkillMetadataTemplatesConfigSchema = z
  .object({ rules: z.array(RuleSchema).default([]) })
  .strict();

export type SkillMetadataTemplatesOptions = z.input<typeof SkillMetadataTemplatesConfigSchema>;
type Rule = z.output<typeof RuleSchema>;
export type PreparedRule = Pick<Rule, "name" | "when" | "position" | "sessionBranch"> & {
  template: string;
};
export type RenderedInstructions = Record<z.output<typeof PositionSchema>, string[]>;
export type SkillTemplateRuntime = {
  sessionBranch?: { pathShell: string };
  skillInvocation: { shell: string };
};
type Frontmatter = Record<string, unknown>;
type Metadata = Record<string, unknown>;
type Environment = Readonly<Record<string, string | undefined>>;
export type MatchedSkill = {
  body: string;
  frontmatter: Frontmatter;
  matchingRules: PreparedRule[];
  sessionBranch?: z.output<typeof SessionBranchSchema>;
};
type RenderedSkill = { body: string; instructions?: RenderedInstructions };

const PLACEHOLDER_PATTERN = /{{\s*([^{}]*?)\s*}}/g;

const isRecord = (value: unknown): value is Metadata =>
  Object.prototype.toString.call(value) === "[object Object]";

const expandHome = (filePath: string): string =>
  filePath === "~" || filePath.startsWith("~/")
    ? path.join(os.homedir(), filePath.slice(2))
    : filePath;

export const resolveTemplateFilePath = (filePath: string, baseDir: string): string => {
  const expandedPath = expandHome(filePath);
  return path.isAbsolute(expandedPath) ? expandedPath : path.resolve(baseDir, expandedPath);
};

const assertValidTemplate = (template: string, ruleName: string): void => {
  const placeholders = [...template.matchAll(PLACEHOLDER_PATTERN)];
  const remainder = template.replace(PLACEHOLDER_PATTERN, "");
  const malformed =
    template.includes("{{{") ||
    template.includes("}}}") ||
    placeholders.some((match) => !match[1]?.trim()) ||
    remainder.includes("{{") ||
    remainder.includes("}}");
  if (malformed) throw new Error(`Rule "${ruleName}" template has malformed placeholders`);
};

const loadTemplateFile = (rule: Rule, baseDir: string): string => {
  const templatePath = resolveTemplateFilePath(rule.templateFile!, baseDir);
  try {
    return fs.readFileSync(templatePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Rule "${rule.name}" could not read templateFile ${templatePath}: ${message}`);
  }
};

export const prepareRules = (
  options: SkillMetadataTemplatesOptions,
  baseDir: string,
): PreparedRule[] =>
  SkillMetadataTemplatesConfigSchema.parse(options).rules.map((rule) => {
    const template = rule.template ?? loadTemplateFile(rule, baseDir);
    assertValidTemplate(template, rule.name);
    return {
      name: rule.name,
      when: rule.when,
      position: rule.position,
      sessionBranch: rule.sessionBranch,
      template,
    };
  });

const pathValue = (root: Frontmatter, valuePath: string): unknown =>
  valuePath.split(".").reduce<unknown>((value, key) => {
    if (!isRecord(value) || !Object.hasOwn(value, key)) return undefined;
    return value[key];
  }, root);

const matchesRule = (rule: PreparedRule, metadata: Metadata, environment: Environment): boolean =>
  Object.entries(rule.when.metadata).every(
    ([metadataPath, expected]) => pathValue(metadata, metadataPath) === expected,
  ) &&
  Object.entries(rule.when.environment).every(([name, expected]) =>
    expected === null ? environment[name] === undefined : environment[name] === expected,
  );

const renderValue = (ruleName: string, valuePath: string, value: unknown): string => {
  if (value === undefined) {
    const source = valuePath.startsWith("runtime.") ? "runtime" : "frontmatter";
    throw new Error(`Rule "${ruleName}" uses missing ${source} value "${valuePath}"`);
  }
  if (typeof value === "string") return value;
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return `${value}`;
  }
  throw new Error(`Rule "${ruleName}" placeholder "${valuePath}" is not a scalar value`);
};

const renderRule = (
  rule: PreparedRule,
  frontmatter: Frontmatter,
  runtime: SkillTemplateRuntime | undefined,
): string =>
  rule.template.replace(PLACEHOLDER_PATTERN, (_match, placeholder: string) => {
    const valuePath = placeholder.trim();
    const root = valuePath.startsWith("runtime.") ? runtime : frontmatter;
    const resolvedPath = valuePath.startsWith("runtime.") ? valuePath.slice(8) : valuePath;
    return renderValue(rule.name, valuePath, pathValue(root ?? {}, resolvedPath));
  });

export const matchSkill = (
  content: string,
  rules: PreparedRule[],
  environment: Environment = process.env,
): MatchedSkill => {
  const { body, frontmatter } = parseFrontmatter<Frontmatter>(content);
  const metadata = isRecord(frontmatter.metadata) ? frontmatter.metadata : {};
  const matchingRules = rules.filter((rule) => matchesRule(rule, metadata, environment));
  const sessionBranch = matchingRules.some((rule) => rule.sessionBranch === "previousTurn")
    ? "previousTurn"
    : undefined;
  return { body: body.trim(), frontmatter, matchingRules, sessionBranch };
};

export const renderMatchedSkill = (
  matched: MatchedSkill,
  runtime?: SkillTemplateRuntime,
): RenderedSkill => {
  if (matched.matchingRules.length === 0) return { body: matched.body };

  const instructions: RenderedInstructions = { top: [], bottom: [], replace: [] };
  matched.matchingRules.forEach((rule) =>
    instructions[rule.position].push(renderRule(rule, matched.frontmatter, runtime)),
  );
  return { body: matched.body, instructions };
};

export const renderSkill = (
  content: string,
  rules: PreparedRule[],
  environment: Environment = process.env,
  runtime?: SkillTemplateRuntime,
): RenderedSkill => renderMatchedSkill(matchSkill(content, rules, environment), runtime);

export const applyInstructions = (content: string, instructions: RenderedInstructions): string => {
  const middle = instructions.replace.length > 0 ? instructions.replace : [content];
  return [...instructions.top, ...middle, ...instructions.bottom].join("\n\n");
};
