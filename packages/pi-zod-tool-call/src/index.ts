import { Type } from "@sinclair/typebox";
import { z } from "zod";

type JsonObject = Record<string, unknown>;

const UNION_KEYS = ["oneOf", "anyOf"] as const;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const compactSchema = (schema: JsonObject): JsonObject =>
  Object.fromEntries(Object.entries(schema).filter(([, value]) => value !== undefined));

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const schemaArray = (schema: JsonObject, key: (typeof UNION_KEYS)[number]): JsonObject[] => {
  const value = schema[key];
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
};

const objectVariants = (schema: JsonObject): JsonObject[] => {
  if (schema.type === "object") return [schema];
  return UNION_KEYS.flatMap((key) => schemaArray(schema, key).flatMap(objectVariants));
};

const schemaProperties = (schema: JsonObject): JsonObject =>
  isJsonObject(schema.properties) ? schema.properties : {};

const uniqueValues = (values: unknown[]): unknown[] =>
  values.filter((value, index) => values.findIndex((item) => Object.is(item, value)) === index);

const schemaValues = (schema: JsonObject): unknown[] => {
  if (schema.const !== undefined) return [schema.const];
  return Array.isArray(schema.enum) ? schema.enum : [];
};

const primitiveType = (schema: JsonObject): string | undefined =>
  typeof schema.type === "string" ? schema.type : undefined;

const schemaTypes = (schema: JsonObject): string[] => {
  const direct = primitiveType(schema);
  if (direct) return [direct];
  return UNION_KEYS.flatMap((key) => schemaArray(schema, key).flatMap(schemaTypes));
};

const valueTypes = (values: unknown[]): string[] =>
  uniqueValues(values.map((value) => typeof value)).filter(
    (type): type is string => typeof type === "string",
  );

const firstDescription = (schemas: JsonObject[]): string | undefined =>
  schemas.find((schema) => typeof schema.description === "string")?.description as
    | string
    | undefined;

const firstDefault = (schemas: JsonObject[]): unknown =>
  schemas.find((schema) => schema.default !== undefined)?.default;

const schemaMetadata = (schemas: JsonObject[]): JsonObject => {
  const description = firstDescription(schemas);
  const defaultValue = firstDefault(schemas);
  return {
    ...(description ? { description } : {}),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
  };
};

const enumSchema = (schemas: JsonObject[]): JsonObject | undefined => {
  const values = uniqueValues(schemas.flatMap(schemaValues));
  if (values.length === 0) return undefined;

  const types = valueTypes(values);
  const metadata = schemaMetadata(schemas);
  if (types.length === 1 && types[0] === "boolean" && values.length === 2)
    return { ...metadata, type: "boolean" };
  if (types.length === 1) return { ...metadata, type: types[0], enum: values };
  return { ...metadata, enum: values };
};

const acceptsAllValues = (schema: JsonObject, values: unknown[]): boolean => {
  const type = primitiveType(schema);
  return (
    schemaValues(schema).length === 0 &&
    Boolean(type) &&
    values.every((value) => typeof value === type)
  );
};

const looseSchema = (schemas: JsonObject[]): JsonObject => {
  const enumOnly = enumSchema(schemas);
  if (enumOnly) return enumOnly;

  const types = uniqueValues(schemas.flatMap(schemaTypes));
  const metadata = schemaMetadata(schemas);
  if (types.length === 1 && typeof types[0] === "string") return { ...metadata, type: types[0] };
  return metadata;
};

const mergePropertySchema = (current: unknown, next: unknown): unknown => {
  if (!isJsonObject(current)) return next;
  if (!isJsonObject(next)) return current;
  if (JSON.stringify(current) === JSON.stringify(next)) return current;
  if (acceptsAllValues(current, schemaValues(next))) return current;
  if (acceptsAllValues(next, schemaValues(current))) return next;
  return looseSchema([current, next]);
};

const mergeProperties = (variants: JsonObject[]): JsonObject =>
  variants.reduce<JsonObject>((properties, variant) => {
    Object.entries(schemaProperties(variant)).forEach(([key, value]) => {
      properties[key] = mergePropertySchema(properties[key], value);
    });
    return properties;
  }, {});

const requiredIntersection = (variants: JsonObject[]): string[] => {
  const required = variants.map((variant) => stringArray(variant.required));
  const [first = []] = required;
  return first.filter((key) => required.every((keys) => keys.includes(key)));
};

const providerCompatibleParametersFromZod = <TZod extends z.ZodType>(
  zodSchema: TZod,
): JsonObject => {
  const schema = z.toJSONSchema(zodSchema, { io: "input" }) as JsonObject;
  const variants = objectVariants(schema);
  if (schema.type === "object") return compactSchema(schema);
  if (variants.length === 0) return compactSchema({ ...schema, type: "object" });

  const required = requiredIntersection(variants);
  return compactSchema({
    $schema: schema.$schema,
    type: "object",
    properties: mergeProperties(variants),
    required: required.length > 0 ? required : undefined,
  });
};

const typeBoxSchemaFromZod = <TZod extends z.ZodType>(zodSchema: TZod) =>
  Type.Unsafe<z.input<TZod>>(providerCompatibleParametersFromZod(zodSchema));

const invalidInputMessage = (toolName: string, error: z.ZodError): string =>
  `Invalid ${toolName} input: ${error.issues.map((issue) => issue.message).join("; ")}`;

export const defineZodToolCall = <TZod extends z.ZodType, TInvalidResult>(input: {
  toolName: string;
  zodSchema: TZod;
  invalidInput: (message: string) => TInvalidResult;
}) => {
  const handleInput = async <TResult>(
    params: unknown,
    onValid: (data: z.infer<TZod>) => Promise<TResult> | TResult,
  ) => {
    const parsed = input.zodSchema.safeParse(params);
    if (!parsed.success) {
      return input.invalidInput(invalidInputMessage(input.toolName, parsed.error));
    }

    return onValid(parsed.data);
  };

  return {
    toolName: input.toolName,
    zodSchema: input.zodSchema,
    typeBoxSchema: typeBoxSchemaFromZod(input.zodSchema),
    handleInput,
  };
};
