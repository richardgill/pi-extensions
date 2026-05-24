import type { KeyId } from "@earendil-works/pi-tui";
import { loadConfigOrDefault } from "@richardgill/pi-config";
import { z } from "zod";

export type ParrotOptions = {
  keyboardShortcut?: KeyId | false;
};

type ResolvedOptions = {
  keyboardShortcut: KeyId | false;
};

export const ParrotOptionsSchema = z.object({
  keyboardShortcut: z.union([z.string(), z.literal(false)]).default("alt+r"),
});

export const ParrotConfigSchema = ParrotOptionsSchema;

export const DEFAULT_OPTIONS = ParrotOptionsSchema.parse({}) as ResolvedOptions;

export const resolveOptions = (options: ParrotOptions = {}): ResolvedOptions =>
  ParrotOptionsSchema.parse(options) as ResolvedOptions;

export const loadParrotConfig = (): ResolvedOptions =>
  resolveOptions(
    loadConfigOrDefault({
      filename: "parrot.jsonc",
      schema: ParrotConfigSchema,
    }) as ParrotOptions,
  );
