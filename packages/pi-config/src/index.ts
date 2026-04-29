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
  defaultValue?: unknown;
};

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
  defaultValue = {},
}: LoadConfigOrDefaultOptions<Schema>): z.infer<Schema> => {
  const filePath = path.resolve(folder, filename);
  if (!fs.existsSync(filePath)) return parseConfig(filePath, schema, defaultValue);
  return loadConfigFile(filePath, schema);
};

const loadConfigFile = <Schema extends z.ZodType>(
  filePath: string,
  schema: Schema,
): z.infer<Schema> => {
  const content = readConfigFile(filePath);
  const value = parseJsoncConfig(filePath, content);
  return parseConfig(filePath, schema, value);
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

const getLineAndColumn = (content: string, offset: number) => {
  const beforeOffset = content.slice(0, offset);
  const lines = beforeOffset.split("\n");
  const line = lines.length;
  const column = (lines.at(-1)?.length ?? 0) + 1;
  return { line, column };
};
