import { describe, expect, it } from "vitest";
import { TMUX_ACTIONS } from "../src/config";
import { buildBashToolCallSchema } from "../src/tool-call-schemas";

type TestOptions = Parameters<typeof buildBashToolCallSchema>[0];

const options: TestOptions = {
  bashToolName: "bash",
  tmuxToolName: "tmux",
  defaultTimeoutSeconds: 30,
  defaultTimeoutAction: "background",
  maxTimeoutSeconds: 60,
  defaultPollInterval: 0,
  pollContextLines: 30,
  tmuxEnabledActions: TMUX_ACTIONS,
  bashPollIntervalEnabled: true,
};

const invalidInput = (message: string) => ({ error: message });
const bashToolCallSchema = (overrides: Partial<typeof options> = {}) =>
  buildBashToolCallSchema({ ...options, ...overrides }, invalidInput);

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

  it.each(["background", "kill"] as const)(
    "defaults omitted timeoutAction to %s",
    async (defaultTimeoutAction) => {
      const result = await bashToolCallSchema({ defaultTimeoutAction }).handleInput(
        { command: "sleep 10" },
        (input) => input,
      );

      expect(result).toMatchObject({ timeoutAction: defaultTimeoutAction });
    },
  );

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
