import { describe, expect, it } from "vitest";
import { buildBashToolCallSchema } from "../src/tool-call-schemas.js";

const options = {
  defaultTimeoutSeconds: 30,
  maxTimeoutSeconds: 60,
  defaultPollInterval: 0,
  pollContextLines: 30,
};

const invalidInput = (message: string) => ({ error: message });
const bashToolCallSchema = () => buildBashToolCallSchema(options, invalidInput);

describe("zod tool call schema generation", () => {
  it("generates top-level object schemas without top-level unions", () => {
    const schema = bashToolCallSchema().typeBoxSchema;

    expect(schema.type).toBe("object");
    expect(schema.oneOf).toBeUndefined();
    expect(schema.anyOf).toBeUndefined();
    expect(schema.allOf).toBeUndefined();
  });

  it("keeps only fields required in every union variant", () => {
    const schema = bashToolCallSchema().typeBoxSchema;

    expect(schema.required).toEqual(["command"]);
  });

  it("loosens discriminators for provider compatibility", () => {
    const schema = bashToolCallSchema().typeBoxSchema;

    expect(schema.properties.background.type).toBe("boolean");
    expect(schema.properties.background.const).toBeUndefined();
    expect(schema.properties.timeoutAction.enum).toEqual(
      expect.arrayContaining(["background", "kill"]),
    );
  });

  it("preserves useful descriptions and defaults", () => {
    const schema = bashToolCallSchema().typeBoxSchema;

    expect(schema.properties.command.description).toContain("Bash command");
    expect(schema.properties.timeout.default).toBe(30);
    expect(schema.properties.timeoutAction.default).toBe("background");
    expect(schema.properties.pollLines.default).toBe(30);
  });

  it("defaults omitted timeoutAction to background", async () => {
    const result = await bashToolCallSchema().handleInput(
      { command: "sleep 10" },
      (input) => input,
    );

    expect(result).toMatchObject({ timeoutAction: "background" });
  });

  it.each([
    ["explicit kill timeout action", { command: "sleep 10", timeoutAction: "kill" }, "kill"],
    [
      "explicit background timeout action",
      { command: "sleep 10", timeoutAction: "background" },
      "background",
    ],
  ])("parses %s", async (_name, input, timeoutActionValue) => {
    const result = await bashToolCallSchema().handleInput(input, (parsed) => parsed);

    expect(result).toMatchObject({ timeoutAction: timeoutActionValue });
  });

  it("parses background true without defaulting timeoutAction", async () => {
    const result = await bashToolCallSchema().handleInput(
      { command: "sleep 10", background: true },
      (input) => input,
    );

    expect(result).toMatchObject({ background: true });
    expect(result).not.toHaveProperty("timeoutAction");
  });

  it("rejects invalid timeoutAction", async () => {
    const result = await bashToolCallSchema().handleInput(
      { command: "sleep 10", timeoutAction: "wait" },
      (input) => input,
    );

    expect(result).toEqual({ error: expect.stringContaining("Invalid bash input") });
  });

  it("handleInput returns invalidInput result on zod failure", async () => {
    const result = await bashToolCallSchema().handleInput({ command: "" }, () => ({ ok: true }));

    expect(result).toEqual({ error: expect.stringContaining("Invalid bash input") });
  });
});
