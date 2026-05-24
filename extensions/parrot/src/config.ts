import type { KeyId } from "@earendil-works/pi-tui";
import { loadConfigOrDefault } from "@richardgill/pi-config";
import { z } from "zod";

export type ParrotOptions = {
  keyboardShortcut?: KeyId | false;
  openExternalEditor?: boolean;
  sendAfterEditorClose?: boolean;
};

export type ResolvedOptions = {
  keyboardShortcut: KeyId | false;
  openExternalEditor: boolean;
  sendAfterEditorClose: boolean;
};

const buildParrotOptionsSchema = () =>
  z.object({
    keyboardShortcut: z.union([z.string(), z.literal(false)]).default("alt+r"),
    openExternalEditor: z.boolean().default(false),
    sendAfterEditorClose: z.boolean().default(false),
  });

export const ParrotOptionsSchema = buildParrotOptionsSchema();
export const ParrotConfigSchema = buildParrotOptionsSchema();

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
