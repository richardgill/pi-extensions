import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { selectCurrent } from "../src/index";

type ContextUi = ExtensionContext["ui"];
type FactoryArgs = Parameters<Parameters<ContextUi["custom"]>[0]>;
const testCases = it;
const title = "Select a tier";
const options = ["off", "fast", "ultrafast"];

const fakeCtx = (mode: ExtensionContext["mode"], ui: Partial<ContextUi>) =>
  ({ mode, hasUI: mode === "tui" || mode === "rpc", ui }) as ExtensionContext;

const driveTui = ({
  move,
  finish,
  width = 60,
}: {
  move?: string;
  finish: string;
  width?: number;
}) => {
  const frames: string[][] = [];
  const tui = { requestRender: vi.fn() } as unknown as FactoryArgs[0];
  const keybindings = {} as FactoryArgs[2];
  const theme = {
    fg: (_color: string, text: string) => `[${text}]`,
    bold: (text: string) => text,
  } as ContextUi["theme"];

  const custom: ContextUi["custom"] = (factory) =>
    new Promise((done, reject) => {
      void Promise.resolve(factory(tui, theme, keybindings, done))
        .then((component) => {
          frames.push(component.render(width));
          if (move) {
            component.handleInput?.(move);
            frames.push(component.render(width));
          }
          component.handleInput?.(finish);
        })
        .catch(reject);
    });
  return { ctx: fakeCtx("tui", { custom }), frames };
};

testCases.each([
  { name: "confirm on open", current: "fast", opening: "[→ fast] ✓", expected: "fast" },
  {
    name: "navigate before confirming",
    current: "fast",
    move: "\x1b[B",
    opening: "[→ fast] ✓",
    afterMove: ["  fast ✓", "[→ ultrafast]"],
    expected: "ultrafast",
  },
  { name: "current is not listed", current: "missing", opening: "[→ off]", expected: "off" },
  { name: "no current", opening: "[→ off]", expected: "off" },
  { name: "cancel", current: "fast", opening: "[→ fast] ✓", finish: "\x1b" },
])("TUI: $name", async ({ current, move, opening, afterMove, expected, finish = "\r" }) => {
  const { ctx, frames } = driveTui({ move, finish });
  expect(await selectCurrent(ctx, { title, options, current })).toBe(expected);

  expect(frames[0]).toContain(opening);
  expect(frames[0].filter((line) => line.includes("✓"))).toEqual(
    opening.endsWith("✓") ? [opening] : [],
  );
  if (afterMove) expect(frames[1]).toEqual(expect.arrayContaining(afterMove));
});

it("keeps the marker visible when the current label is truncated", async () => {
  const current = "a long option label";
  const { ctx, frames } = driveTui({ finish: "\r", width: 10 });
  expect(await selectCurrent(ctx, { title, options: [current], current })).toBe(current);
  expect(frames[0].map(stripVTControlCharacters)).toContain("[→ a lo] ✓");
});

testCases.each([
  { options, current: "fast", labels: ["off", "fast ✓", "ultrafast"], index: 1, expected: "fast" },
  { options, current: "fast", labels: ["off", "fast ✓", "ultrafast"], index: 0, expected: "off" },
  { options, current: "fast", labels: ["off", "fast ✓", "ultrafast"] },
  {
    options: ["fast", "fast ✓"],
    current: "fast",
    labels: ["fast  ✓", "fast ✓"],
    index: 1,
    expected: "fast ✓",
  },
])(
  "RPC: labels $labels, selecting row $index",
  async ({ options, current, labels, index, expected }) => {
    const select = vi.fn(async (_title: string, choices: string[]) =>
      index === undefined ? undefined : choices[index],
    );
    const custom = vi.fn(() => {
      throw new Error("Unexpected TUI prompt");
    });
    const ctx = fakeCtx("rpc", { select, custom });

    expect(await selectCurrent(ctx, { title, options, current })).toBe(expected);
    expect(select).toHaveBeenCalledWith(title, labels);
    expect(custom).not.toHaveBeenCalled();
  },
);

testCases.each([
  { mode: "tui", options: [] },
  { mode: "print", options },
  { mode: "json", options },
] as const)("does not prompt in $mode with options $options", async ({ mode, options }) => {
  const custom = vi.fn();
  const select = vi.fn();
  expect(
    await selectCurrent(fakeCtx(mode, { custom, select }), { title, options }),
  ).toBeUndefined();
  expect(custom).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
});
