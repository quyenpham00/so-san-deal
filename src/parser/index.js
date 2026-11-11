// File → deal rows. PDFs are read with pdf.js (text layer only); spreadsheets with SheetJS.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import * as XLSX from "xlsx";
import { parsePages, parseSheet } from "./table.js";

export async function readPdfPages(buffer) {
  const doc = await getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  try {
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const [vx0, vy0, vx1, vy1] = page.view;
      pages.push({
        page: p,
        width: vx1 - vx0,
        height: vy1 - vy0,
        items: tc.items
          .filter((it) => it.str && it.str.trim())
          .map((it) => ({
            str: it.str,
            x: it.transform[4],
            y: it.transform[5],
            w: it.width || 0,
            fs: Math.abs(it.transform[3]) || 8,
          })),
      });
      page.cleanup();
    }
    return pages;
  } finally {
    await doc.destroy();
  }
}

/**
 * @param {Buffer} buffer file bytes
 * @param {string} filename used to pick the reader (.pdf / .xlsx / .xls / .csv)
 */
export async function parseDealFile(buffer, filename) {
  const isPdf = /\.pdf$/i.test(filename) || buffer.subarray(0, 5).toString("latin1") === "%PDF-";
  if (isPdf) return parsePages(await readPdfPages(buffer));
  if (!/\.(xlsx|xls|csv)$/i.test(filename)) {
    throw new UserError("Chỉ nhận file PDF, Excel (.xlsx, .xls) hoặc CSV.");
  }
  // CSV bytes are UTF-8 (Excel's "CSV UTF-8" adds a BOM); SheetJS would otherwise read them as Latin-1
  const wb = /\.csv$/i.test(filename)
    ? XLSX.read(buffer.toString("utf8").replace(/^﻿/, ""), { type: "string", raw: true })
    : XLSX.read(buffer, { type: "buffer" });
  const out = { rows: [], voucherLabels: [], session: "" };
  for (const name of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: "" });
    const r = parseSheet(aoa);
    out.rows.push(...r.rows);
    if (!out.voucherLabels.length) out.voucherLabels = r.voucherLabels;
  }
  return out;
}

/** An error whose message is safe to show to the admin. */
export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
