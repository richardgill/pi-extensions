import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { z } from "zod";

export type LoadConfigOptions<Schema extends z.ZodType> = {
  folder?: string;
  filename: string;
  schema: Schema;
};

export type LoadConfigOrDefaultOptions<Schema extends z.ZodType> = LoadConfigOptions<Schema> & {
  defaults: unknown;
};

export type DefaultsInput<Options> = Options extends unknown[]
  ? Options
  : Options extends object
    ? { [Key in keyof Options]?: DefaultsInput<Options[Key]> }
    : Options;

export const loadConfig = <Schema extends z.ZodType>({
  folder = getAgentDir(),
  filename,
  schema,
}: LoadConfigOptions<Schema>): z.infer<Schema> => {
  const filePath = path.resolve(folder, filename);
  return loadConfigFile(filePath, schema);
};

export const loadConfigOrDefault = <Schema extends z.ZodType>({
  folder = getAgentDir(),
  filename,
  schema,
  defaults,
}: LoadConfigOrDefaultOptions<Schema>): z.infer<Schema> => {
  const filePath = path.resolve(folder, filename);
  const value = fs.existsSync(filePath) ? readConfigValue(filePath) : {};
  return parseConfig(filePath, schema, mergeDefaults(defaults, value));
};

export const resolveOptions = <Options extends object>(
  defaults: Options,
  input: DefaultsInput<Options> = {} as DefaultsInput<Options>,
): Options => mergeDefaults(defaults, input) as Options;

const loadConfigFile = <Schema extends z.ZodType>(
  filePath: string,
  schema: Schema,
): z.infer<Schema> => parseConfig(filePath, schema, readConfigValue(filePath));

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
