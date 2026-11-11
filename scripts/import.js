// Import a deal-list file or a Google Drive / Google Sheets link from the command line.
// Usage: npm run import -- <file.pdf|.xlsx|.csv|Drive link> [--title "Tên"] [--publish] [--pin] [--no-images]
import { readFileSync } from "node:fs";
import path from "node:path";
import { openDb } from "../src/db.js";
import { parseDealFile } from "../src/parser/index.js";
import { parsePages } from "../src/parser/table.js";
import { createDrive } from "../src/drive.js";
import { createImageStore } from "../src/images.js";
import { createImageJobs, pictureSource } from "../src/imageJob.js";

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--title");
if (!input) {
  console.error('Usage: npm run import -- <file.pdf|.xlsx|.csv|Google Drive link> [--title "Tên"] [--publish] [--pin]');
  process.exit(1);
}
const ti = args.indexOf("--title");

let parsed, filename, source, pictures;
try {
  if (/^https?:\/\//i.test(input)) {
    const got = await createDrive().fetchLink(input);
    if (got.folder) {
      console.log("This is a folder. Import one of its files:");
      for (const f of got.folder) console.log(`  ${f.name}\n    ${f.kind === "sheet" ? `https://docs.google.com/spreadsheets/d/${f.id}/edit` : `https://drive.google.com/file/d/${f.id}/view`}`);
      process.exit(got.folder.length ? 0 : 2);
    }
    filename = got.filename;
    source = `${filename} · Google Drive`;
    parsed = got.pages ? parsePages(got.pages) : await parseDealFile(got.buffer, filename);
    pictures = pictureSource({ ...got, filename });
  } else {
    filename = path.basename(input);
    source = filename;
    const buffer = readFileSync(input);
    parsed = await parseDealFile(buffer, filename);
    pictures = pictureSource({ buffer, filename });
  }
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
if (!parsed.rows.length) {
  console.error("No deal table found in", input);
  process.exit(2);
}
const title = ti >= 0 ? args[ti + 1] : filename.replace(/\.[a-z0-9]+$/i, "");
const dbPath = process.env.DB_PATH || "data/so-san-deal.db";
const store = openDb(dbPath);
const list = store.createList({
  title,
  session: parsed.session,
  source,
  voucherLabels: parsed.voucherLabels,
  rows: parsed.rows,
  published: args.includes("--publish"),
  pinned: args.includes("--pin"),
});
console.log(`Imported "${list.title}" (#${list.id}): ${list.dealCount} deals, vouchers: ${parsed.voucherLabels.join(", ") || "none"}` +
  `${list.published ? ", published" : ", draft"}${list.pinned ? ", pinned" : ""}`);
if (pictures && !args.includes("--no-images")) {
  const images = createImageStore(process.env.IMAGES_DIR || path.join(path.dirname(dbPath), "images"));
  process.stdout.write("Cutting out product pictures…");
  const r = await createImageJobs({ store, images }).run(list.id, parsed.rows, pictures);
  console.log(r.error ? ` failed: ${r.error.message}` : ` ${r.saved} deals have pictures.`);
}
store.close();
