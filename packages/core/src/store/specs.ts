import { z } from "zod";

/** Product specs the agent writes. Kept free of native deps so the dashboard can import it. */

const cell = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);

export const SpreadsheetSpec = z.object({
  instructions: z.string().max(4000).describe("Plain-language 'How to use' text, placed on the first sheet"),
  sheets: z.array(z.object({
    name: z.string().min(1).max(31),
    columns: z.array(z.object({
      header: z.string().min(1).max(60),
      width: z.number().min(6).max(80).optional(),
      format: z.enum(["text", "number", "currency", "percent", "date", "checkbox"]).optional(),
    })).min(1).max(30),
    rows: z.array(z.array(cell).max(30)).max(400).describe("Starter rows. Strings beginning with '=' are Excel formulas, e.g. '=SUM(B2:B20)'"),
    blank_rows: z.number().int().min(0).max(500).optional().describe("Extra empty, formatted rows for the buyer to fill in"),
  })).min(1).max(12),
});

const block = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(2000) }),
  z.object({ type: z.literal("lines"), label: z.string().max(80).optional(), count: z.number().int().min(1).max(40) }),
  z.object({ type: z.literal("checklist"), label: z.string().max(80).optional(), items: z.array(z.string().max(120)).max(40).optional(), count: z.number().int().min(0).max(40).optional() }),
  z.object({ type: z.literal("grid"), label: z.string().max(80).optional(), columns: z.array(z.string().max(40)).min(1).max(8), rows: z.number().int().min(1).max(40) }),
]);

export const PlannerSpec = z.object({
  page_size: z.enum(["LETTER", "A4"]).optional(),
  accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  pages: z.array(z.object({
    title: z.string().min(1).max(80),
    subtitle: z.string().max(160).optional(),
    repeat: z.number().int().min(1).max(53).optional().describe("Print this page N times (e.g. 52 weekly pages)"),
    blocks: z.array(block).min(1).max(12),
  })).min(1).max(40),
});

export type SpreadsheetSpecT = z.infer<typeof SpreadsheetSpec>;
export type PlannerSpecT = z.infer<typeof PlannerSpec>;

