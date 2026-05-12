import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { z } from "zod";

type LoadConfigOptions<Schema extends z.ZodType> = {
  folder?: string;
  filename: string;
  schema: Schema;
  renderTemplates?: boolean;
};

type LoadConfigOrDefaultOptions<Schema extends z.ZodType> = LoadConfigOptions<Schema> & {
  defaults: unknown;
};

type DefaultsInput<Options> = Options extends unknown[]
  ? Options
  : Options extends object
    ? { [Key in keyof Options]?: DefaultsInput<Options[Key]> }
    : Options;

type TemplateMissingBehavior = "keep" | "throw";

type TemplateStringOptions = {
  variables: string[];
  missing?: TemplateMissingBehavior;
};

type RenderConfigTemplateOptions = TemplateStringOptions & {
  fieldPath?: string;
};

type TemplateMetadata = {
  piConfigTemplate?: TemplateStringOptions;
};

export const loadConfigOrDefault = <Schema extends z.ZodType>({
  folder = getDefaultConfigFolder(),
  filename,
  schema,
  defaults,
  renderTemplates = true,
}: LoadConfigOrDefaultOptions<Schema>): z.infer<Schema> => {
  const filePath = path.resolve(folder, filename);
  const value = fs.existsSync(filePath) ? readConfigValue(filePath) : {};
  return parseConfig(filePath, schema, mergeDefaults(defaults, value), renderTemplates);
};

const getDefaultConfigFolder = (): string => process.env.PI_EXTENSION_CONFIG_DIR ?? getAgentDir();

export const resolveOptions = <Options extends object>(
  defaults: Options,
  input: DefaultsInput<Options> = {} as DefaultsInput<Options>,
): Options => mergeDefaults(defaults, input) as Options;

export const templatedString = (options: TemplateStringOptions): z.ZodString =>
  z.string().meta({
    piConfigTemplate: { ...options, variables: [...options.variables] },
  });

const renderConfigTemplate = (
  template: string,
  values: Record<string, unknown>,
  options: RenderConfigTemplateOptions,
): string => {
  assertTemplateIsWellFormed(template, options.fieldPath ?? "template");
  return template.replace(/{{\s*([^{}]*?)\s*}}/g, (match, variable: string) =>
    renderTemplateVariable(match, variable.trim(), values, options),
  );
};

const renderSchemaTemplates = <Value>(schema: z.ZodType, value: Value): Value =>
  renderSchemaValue(schema, value, value, "config") as Value;

const readConfigValue = (filePath: string): unknown => {
  const content = readConfigFile(filePath);
  return parseJsoncConfig(filePath, content);
};

const readConfigFile = (filePath: string): string => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }

  return fs.readFileSync(filePath, "utf8");
};

const parseJsoncConfig = (filePath: string, content: string): unknown => {
  const errors: ParseError[] = [];
  const value = parse(content, errors, { allowTrailingComma: true, disallowComments: false });

  if (errors.length > 0) {
    throw new Error(formatJsoncError(filePath, content, errors[0]!));
  }

  return value;
};

const parseConfig = <Schema extends z.ZodType>(
  filePath: string,
  schema: Schema,
  value: unknown,
  renderTemplates: boolean,
): z.infer<Schema> => {
  const preparedValue = renderTemplates ? renderSchemaTemplates(schema, value) : value;
  return validateConfig(filePath, schema, preparedValue);
};

const validateConfig = <Schema extends z.ZodType>(
  filePath: string,
  schema: Schema,
  value: unknown,
): z.infer<Schema> => {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new Error(`Invalid config in ${filePath}:\n${result.error.message}`);
  }

  return result.data;
};

const formatJsoncError = (filePath: string, content: string, error: ParseError): string => {
  const location = getLineAndColumn(content, error.offset);
  const code = printParseErrorCode(error.error);
  return `Invalid JSONC in ${filePath}:${location.line}:${location.column}: ${code}`;
};

const renderSchemaValue = (
  schema: z.ZodType,
  value: unknown,
  rootValue: unknown,
  fieldPath: string,
): unknown => {
  const templateOptions = getTemplateOptions(schema);

  if (templateOptions) {
    if (typeof value !== "string") return value;
    return renderConfigTemplate(value, valuesRecord(rootValue), { ...templateOptions, fieldPath });
  }

  if (isZodObject(schema) && isRecord(value))
    return renderObjectSchema(schema, value, rootValue, fieldPath);
  if (isZodArray(schema) && Array.isArray(value))
    return renderArraySchema(schema, value, rootValue, fieldPath);

  return value;
};

const renderObjectSchema = (
  schema: z.ZodObject,
  value: Record<string, unknown>,
  rootValue: unknown,
  fieldPath: string,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value).map(([key, fieldValue]) => [
      key,
      renderSchemaValue(
        getObjectFieldSchema(schema, key),
        fieldValue,
        rootValue,
        `${fieldPath}.${key}`,
      ),
    ]),
  );

const renderArraySchema = (
  schema: z.ZodArray,
  value: unknown[],
  rootValue: unknown,
  fieldPath: string,
): unknown[] =>
  value.map((item, index) =>
    renderSchemaValue(schema.element as z.ZodType, item, rootValue, `${fieldPath}.${index}`),
  );

const getObjectFieldSchema = (schema: z.ZodObject, key: string): z.ZodType =>
  (schema.shape[key] as z.ZodType | undefined) ?? z.unknown();

const getTemplateOptions = (schema: z.ZodType): TemplateStringOptions | undefined => {
  const metadata = schema.meta() as TemplateMetadata | undefined;
  if (metadata?.piConfigTemplate) return metadata.piConfigTemplate;

  const innerSchema = getInnerSchema(schema);
  return innerSchema ? getTemplateOptions(innerSchema) : undefined;
};

const getInnerSchema = (schema: z.ZodType): z.ZodType | undefined => {
  const def = schema.def as { innerType?: z.ZodType };
  return def.innerType;
};

const isZodObject = (schema: z.ZodType): schema is z.ZodObject => schema instanceof z.ZodObject;

const isZodArray = (schema: z.ZodType): schema is z.ZodArray => schema instanceof z.ZodArray;

const valuesRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const renderTemplateVariable = (
  match: string,
  variable: string,
  values: Record<string, unknown>,
  options: RenderConfigTemplateOptions,
): string => {
  assertTemplateVariableIsAllowed(variable, options);

  if (!Object.hasOwn(values, variable) || values[variable] === undefined) {
    return handleMissingTemplateVariable(match, variable, options);
  }

  return stringifyTemplateValue(variable, values[variable], options.fieldPath ?? "template");
};

const assertTemplateIsWellFormed = (template: string, fieldPath: string): void => {
  let index = 0;

  for (;;) {
    const openIndex = template.indexOf("{{", index);
    const closeIndex = template.indexOf("}}", index);

    if (closeIndex !== -1 && (openIndex === -1 || closeIndex < openIndex)) {
      throw new Error(`${fieldPath} has unopened template close "}}"`);
    }

    if (openIndex === -1) return;

    const endIndex = template.indexOf("}}", openIndex + 2);
    if (endIndex === -1) throw new Error(`${fieldPath} has unclosed template open "{{"`);

    assertTemplateBody(template.slice(openIndex + 2, endIndex), fieldPath);
    index = endIndex + 2;
  }
};

const assertTemplateBody = (body: string, fieldPath: string): void => {
  if (!body.trim()) throw new Error(`${fieldPath} has an empty template variable`);
  if (/[{}]/.test(body)) throw new Error(`${fieldPath} has a malformed template variable`);
};

const assertTemplateVariableIsAllowed = (
  variable: string,
  options: RenderConfigTemplateOptions,
): void => {
  if (options.variables.includes(variable)) return;

  throw new Error(
    `${options.fieldPath ?? "template"} uses unknown template variable "${variable}". Allowed: ${options.variables.join(", ")}`,
  );
};

const handleMissingTemplateVariable = (
  match: string,
  variable: string,
  options: RenderConfigTemplateOptions,
): string => {
  if ((options.missing ?? "throw") === "keep") return match;

  throw new Error(
    `${options.fieldPath ?? "template"} uses missing template variable "${variable}"`,
  );
};

const stringifyTemplateValue = (variable: string, value: unknown, fieldPath: string): string => {
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);

  throw new Error(`${fieldPath} uses unsupported template value "${variable}"`);
};

const mergeDefaults = (defaults: unknown, value: unknown): unknown => {
  if (value === undefined) return defaults;
  if (!isRecord(defaults) || !isRecord(value)) return value;

  const keys = new Set([...Object.keys(defaults), ...Object.keys(value)]);
  return Object.fromEntries(
    [...keys].map((key) => [key, mergeDefaults(defaults[key], value[key])]),
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Object.prototype.toString.call(value) === "[object Object]";

const getLineAndColumn = (content: string, offset: number) => {
  const beforeOffset = content.slice(0, offset);
  const lines = beforeOffset.split("\n");
  const line = lines.length;
  const column = (lines.at(-1)?.length ?? 0) + 1;
  return { line, column };
};
