import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { Resvg } from "@resvg/resvg-js";

/**
 * Original digital products, generated from a structured spec the agent
 * writes. The agent designs the content; this code turns it into real files
 * (an .xlsx workbook or a printable PDF planner) plus listing images.
 */

import type { SpreadsheetSpecT, PlannerSpecT } from "./specs.js";
export * from "./specs.js";

// ───────────────────────── Spreadsheet (.xlsx) ─────────────────────────

const NUM_FMT: Record<string, string> = { currency: '"$"#,##0.00', percent: "0.0%", number: "#,##0.##", date: "yyyy-mm-dd" };

export async function renderSpreadsheet(title: string, spec: SpreadsheetSpecT, brand: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = brand; wb.title = title; wb.created = new Date(0); // fixed date keeps output deterministic
  const intro = wb.addWorksheet("How to use");
  intro.getColumn(1).width = 100;
  intro.getCell("A1").value = title; intro.getCell("A1").font = { bold: true, size: 18 };
  intro.getCell("A2").value = `by ${brand}`; intro.getCell("A2").font = { italic: true, color: { argb: "FF666666" } };
  spec.instructions.split(/\n+/).forEach((p, i) => { const c = intro.getCell(`A${4 + i}`); c.value = p; c.alignment = { wrapText: true, vertical: "top" }; });

  for (const s of spec.sheets) {
    const name = s.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31);
    const ws = wb.addWorksheet(wb.getWorksheet(name) ? `${name.slice(0, 28)} ${wb.worksheets.length}` : name, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = s.columns.map((c) => ({ header: c.header, width: c.width ?? Math.max(12, c.header.length + 4) }));
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: "FFFFFFFF" } };
    head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
    s.rows.forEach((r) => ws.addRow(r.map((v) => (typeof v === "string" && v.startsWith("=") ? { formula: v.slice(1) } : v))));
    for (let i = 0; i < (s.blank_rows ?? 0); i++) ws.addRow([]);
    const last = 1 + s.rows.length + (s.blank_rows ?? 0);
    s.columns.forEach((c, ci) => {
      const col = ws.getColumn(ci + 1);
      if (c.format && NUM_FMT[c.format]) col.numFmt = NUM_FMT[c.format];
      if (c.format === "checkbox" && last > 1) {
        for (let r = 2; r <= last; r++) ws.getCell(r, ci + 1).dataValidation = { type: "list", allowBlank: true, formulae: ['"✓,✗"'] };
      }
    });
    for (let r = 2; r <= last; r++) if (r % 2 === 0) ws.getRow(r).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ───────────────────────── Planner (.pdf) ─────────────────────────

export function renderPlanner(title: string, spec: PlannerSpecT, brand: string): Promise<Buffer> {
  const accent = spec.accent_color ?? "#1F2937";
  const doc = new PDFDocument({ size: spec.page_size ?? "LETTER", margin: 48, info: { Title: title, Author: brand, CreationDate: new Date(0) } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));
  const W = doc.page.width - 96;

  // Cover
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(accent);
  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(34).text(title, 48, doc.page.height / 3, { width: W });
  doc.moveDown().font("Helvetica").fontSize(14).text(brand, { width: W });

  for (const p of spec.pages) {
    for (let n = 0; n < (p.repeat ?? 1); n++) {
      doc.addPage();
      doc.rect(48, 40, W, 4).fill(accent);
      doc.fillColor("#111111").font("Helvetica-Bold").fontSize(20).text(p.repeat && p.repeat > 1 ? `${p.title} ${n + 1}` : p.title, 48, 56, { width: W });
      if (p.subtitle) doc.font("Helvetica").fontSize(11).fillColor("#555555").text(p.subtitle, { width: W });
      doc.moveDown(0.8);
      for (const b of p.blocks) {
        if (doc.y > doc.page.height - 110) break; // never overflow a page
        const label = "label" in b && b.label ? b.label : null;
        if (label) { doc.font("Helvetica-Bold").fontSize(12).fillColor(accent).text(label, 48, doc.y, { width: W }); doc.moveDown(0.3); }
        doc.fillColor("#111111").font("Helvetica").fontSize(11);
        if (b.type === "text") { doc.text(b.text, 48, doc.y, { width: W }); doc.moveDown(0.6); continue; }
        if (b.type === "lines") {
          for (let i = 0; i < b.count && doc.y < doc.page.height - 70; i++) { const y = doc.y + 18; doc.moveTo(48, y).lineTo(48 + W, y).strokeColor("#BBBBBB").lineWidth(0.6).stroke(); doc.y = y; }
          doc.moveDown(0.8); continue;
        }
        if (b.type === "checklist") {
          const items = [...(b.items ?? []), ...Array(b.count ?? 0).fill("")];
          for (const it of items) {
            if (doc.y > doc.page.height - 70) break;
            const y = doc.y + 4;
            doc.rect(48, y, 10, 10).strokeColor("#888888").lineWidth(0.8).stroke();
            if (it) doc.fillColor("#111111").text(it, 66, y - 1, { width: W - 18 });
            else doc.moveTo(66, y + 10).lineTo(48 + W, y + 10).strokeColor("#CCCCCC").lineWidth(0.5).stroke();
            doc.y = y + 16;
          }
          doc.moveDown(0.6); continue;
        }
        if (b.type === "grid") {
          const cw = W / b.columns.length, rh = 20, top = doc.y;
          doc.font("Helvetica-Bold").fontSize(9);
          b.columns.forEach((c, i) => { doc.rect(48 + i * cw, top, cw, rh).fillAndStroke("#F3F4F6", "#BBBBBB"); doc.fillColor("#111111").text(c, 52 + i * cw, top + 6, { width: cw - 8, height: rh - 4, ellipsis: true }); });
          let y = top + rh;
          for (let r = 0; r < b.rows && y < doc.page.height - 70; r++, y += rh) b.columns.forEach((_, i) => doc.rect(48 + i * cw, y, cw, rh).strokeColor("#BBBBBB").lineWidth(0.5).stroke());
          doc.y = y + 10; doc.font("Helvetica").fontSize(11);
        }
      }
      doc.font("Helvetica").fontSize(8).fillColor("#999999").text(`${brand} · ${title}`, 48, doc.page.height - 40, { width: W, align: "center", lineBreak: false });
    }
  }
  doc.end();
  return done;
}

// ───────────────────────── Listing images (.png) ─────────────────────────

const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../assets/fonts");
const FONT_FILES = [join(FONT_DIR, "Inter-Regular.otf"), join(FONT_DIR, "Inter-Bold.otf")];

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!));

export function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars && cur) { lines.push(cur); cur = w; } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, "") + "…"; }
  return lines;
}

export interface CoverInput {
  brand: string; headline: string; subhead?: string; badge: string; accent: string; background: string;
  preview: string[]; kind: "spreadsheet" | "planner";
}

function mockup(c: CoverInput): string {
  // A simple stylized page or sheet showing real column/page names from the product.
  const x = 860, y = 560, w = 620, h = 760;
  const rows = c.preview.slice(0, 9);
  if (c.kind === "spreadsheet") {
    return `<g><rect x="${x + 24}" y="${y + 24}" width="${w}" height="${h}" rx="18" fill="#000" opacity="0.18"/>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="#FFFFFF"/>
      <rect x="${x}" y="${y}" width="${w}" height="70" rx="18" fill="${c.accent}"/><rect x="${x}" y="${y + 40}" width="${w}" height="30" fill="${c.accent}"/>
      ${rows.map((r, i) => `<rect x="${x + 30}" y="${y + 100 + i * 70}" width="${w - 60}" height="54" rx="8" fill="${i % 2 ? "#F3F4F6" : "#E5E7EB"}"/>
        <text x="${x + 50}" y="${y + 136 + i * 70}" font-family="Inter" font-size="26" fill="#1F2937">${esc(r.slice(0, 34))}</text>`).join("")}</g>`;
  }
  return `<g><rect x="${x + 40}" y="${y + 40}" width="${w}" height="${h}" rx="14" fill="#FFFFFF" opacity="0.5"/>
    <rect x="${x + 20}" y="${y + 20}" width="${w}" height="${h}" rx="14" fill="#FFFFFF" opacity="0.75"/>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="#FFFFFF"/>
    <rect x="${x + 40}" y="${y + 50}" width="${w - 80}" height="8" fill="${c.accent}"/>
    ${rows.map((r, i) => `<rect x="${x + 40}" y="${y + 100 + i * 70}" width="26" height="26" rx="4" fill="none" stroke="#9CA3AF" stroke-width="3"/>
      <text x="${x + 84}" y="${y + 122 + i * 70}" font-family="Inter" font-size="26" fill="#1F2937">${esc(r.slice(0, 32))}</text>
      <line x1="${x + 40}" y1="${y + 146 + i * 70}" x2="${x + w - 40}" y2="${y + 146 + i * 70}" stroke="#E5E7EB" stroke-width="2"/>`).join("")}</g>`;
}

export function coverSvg(c: CoverInput): string {
  const head = wrap(c.headline, 16, 4);
  const sub = c.subhead ? wrap(c.subhead, 30, 3) : [];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1600" viewBox="0 0 1600 1600">
  <rect width="1600" height="1600" fill="${c.background}"/>
  <circle cx="1450" cy="180" r="380" fill="${c.accent}" opacity="0.18"/>
  <text x="110" y="170" font-family="Inter" font-weight="700" font-size="40" letter-spacing="6" fill="${c.accent}">${esc(c.brand.toUpperCase())}</text>
  ${head.map((l, i) => `<text x="110" y="${330 + i * 118}" font-family="Inter" font-weight="700" font-size="104" fill="#111827">${esc(l)}</text>`).join("")}
  ${sub.map((l, i) => `<text x="110" y="${400 + head.length * 118 + i * 54}" font-family="Inter" font-size="40" fill="#374151">${esc(l)}</text>`).join("")}
  <rect x="110" y="1380" width="${Math.min(640, 60 + c.badge.length * 22)}" height="96" rx="48" fill="${c.accent}"/>
  <text x="150" y="1442" font-family="Inter" font-weight="700" font-size="38" fill="#FFFFFF">${esc(c.badge)}</text>
  ${mockup(c)}
</svg>`;
}

export function renderPng(svg: string): Buffer {
  const r = new Resvg(svg, { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Inter" }, fitTo: { mode: "width", value: 1600 } });
  return Buffer.from(r.render().asPng());
}
