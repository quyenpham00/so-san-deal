import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { picturesFromPageImages, picturesFromPdf } from "../src/images.js";
import { parseDealFile } from "../src/parser/index.js";
import { createImageJobs } from "../src/imageJob.js";
import { createImageStore } from "../src/images.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/app.js";
import { PICTURES } from "./fixtures/make-pictures-pdf.js";

const colour = async (buf) => {
  const { dominant } = await sharp(buf).stats();
  return [dominant.r, dominant.g, dominant.b];
};
const near = (a, b, tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

/* A page picture like Drive's: a white table with 2 px black grid lines.
   Picture column x 200–350; rows y 50–150, 150–250, 250–350. */
async function fakePage() {
  const W = 600, H = 400;
  const px = Buffer.alloc(W * H * 3, 255);
  const fill = (x0, y0, x1, y1, [r, g, b]) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 3; px[i] = r; px[i + 1] = g; px[i + 2] = b; }
  };
  for (const x of [50, 200, 350, 550]) fill(x, 50, x + 2, 352, [0, 0, 0]);
  for (const y of [50, 150, 250, 350]) fill(50, y, 552, y + 2, [0, 0, 0]);
  fill(240, 70, 300, 130, [220, 30, 30]); // row 1: a red picture
  fill(215, 156, 228, 246, [20, 20, 20]); // row 2: a tall dark bottle (not a grid line)…
  fill(260, 190, 330, 230, [30, 90, 220]); // …and a blue box beside it
  // row 3: empty
  return sharp(px, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

test("page pictures: each cell is cut between the grid lines; empty cells give nothing", async () => {
  const png = await fakePage();
  const H = 400;
  // geometry in PDF units (y up), as the table reader gives it: bands and columns are only roughly right
  const rows = [[45, 155], [148, 252], [246, 356]].map(([a, b], i) => ({
    stt: i + 1, geom: { page: 1, top: H - a, bottom: H - b, img: [185, 365], giftImg: null },
  }));
  const handed = [];
  const out = await picturesFromPageImages({ rows, dealIds: [11, 12, 13], pages: [{ page: 1, width: 600, height: 400 }], pagePng: async () => png, onPictures: async (m) => handed.push([...m.keys()]) });
  assert.deepEqual([...out.keys()], [11, 12]);
  assert.deepEqual(handed, [[11, 12]], "each page's pictures are handed over as soon as the page is done");
  const red = await sharp(out.get(11).p).metadata();
  assert.ok(Math.abs(red.width - 66) <= 2 && Math.abs(red.height - 66) <= 2, `red picture trimmed to its size, got ${red.width}x${red.height}`);
  assert.ok(near(await colour(out.get(11).p), [220, 30, 30]));
  const two = await sharp(out.get(12).p).metadata();
  assert.ok(two.width >= 115 && two.width <= 125, `bottle and box kept together, got width ${two.width}`);
});

test("photos that fill their cells and share an edge aren't taken for grid lines; the coloured header isn't a picture", async () => {
  const W = 600, H = 700, rowsN = 6;
  const px = Buffer.alloc(W * H * 3, 255);
  const fill = (x0, y0, x1, y1, [r, g, b]) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 3; px[i] = r; px[i + 1] = g; px[i + 2] = b; }
  };
  fill(50, 20, 552, 50, [240, 140, 60]); // orange header row
  for (const x of [50, 200, 350, 450, 550]) fill(x, 20, x + 2, 52 + rowsN * 100, [0, 0, 0]);
  for (let k = 0; k <= rowsN; k++) fill(50, 50 + k * 100, 552, 52 + k * 100, [0, 0, 0]);
  for (let k = 0; k < rowsN; k++) fill(206, 56 + k * 100, 344, 146 + k * 100, [25 + k * 5, 25, 30]); // dark photos, same left edge
  const png = await sharp(px, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const rows = Array.from({ length: rowsN }, (_, k) => ({
    stt: k + 1, geom: { page: 1, top: H - (48 + k * 100), bottom: H - (152 + k * 100), img: [185, 365], giftImg: [400, 500] },
  }));
  const out = await picturesFromPageImages({ rows, dealIds: rows.map((r) => r.stt), pages: [{ page: 1, width: W, height: H }], pagePng: async () => png });
  assert.equal(out.size, rowsN);
  for (const got of out.values()) {
    assert.ok(!got.g, "empty gift cells stay empty (header colour not taken as a picture)");
    const m = await sharp(got.p).metadata();
    assert.ok(m.width >= 136 && m.width <= 146, `whole photo kept, got width ${m.width}`);
  }
});

test("PDF: embedded pictures land in their own deal (product, gift, combo of two)", async () => {
  const buffer = readFileSync(new URL("./fixtures/deal-pictures.pdf", import.meta.url));
  const parsed = await parseDealFile(buffer, "deal-pictures.pdf");
  assert.deepEqual(parsed.rows.map((r) => r.stt), [1, 2, 3, 4, 5, 6]);
  const out = await picturesFromPdf({ buffer, rows: parsed.rows, dealIds: parsed.rows.map((r) => r.stt) });
  for (const [stt, want] of Object.entries(PICTURES)) {
    const got = out.get(Number(stt)) || {};
    assert.equal(Boolean(got.p), Boolean(want.p), `STT ${stt} product picture`);
    assert.equal(Boolean(got.g), Boolean(want.g), `STT ${stt} gift picture`);
    if (want.p) assert.ok(near(await colour(got.p), want.p), `STT ${stt} product colour`);
    if (want.g) assert.ok(near(await colour(got.g), want.g), `STT ${stt} gift colour`);
  }
  const combo = await sharp(out.get(3).p).metadata();
  assert.ok(combo.width > combo.height, "the two combo pictures are drawn side by side in one thumbnail");
});

/* ---------- import → background job → served pictures ---------- */
let server, base, store, cookie, dir, jobs;
before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "ssd-img-"));
  store = openDb(":memory:");
  jobs = createImageJobs({ store, images: createImageStore(dir), log: { error() {} } });
  const app = createApp({ store, adminPassword: "pw-123456", sessionSecret: "s", imagesDir: dir, imageJobs: jobs });
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "pw-123456" }) });
  cookie = login.headers.get("set-cookie").split(";")[0];
});
after(() => { server.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
const admin = (p, init = {}) => fetch(base + p, { ...init, headers: { Cookie: cookie, "X-Requested-With": "fetch", ...(init.headers || {}) } });

test("an uploaded PDF gets its pictures in the background; they're served and removed with the list", async () => {
  const imp = await (await admin("/api/admin/import", {
    method: "POST", headers: { "X-Filename": "deal-pictures.pdf" }, body: readFileSync(new URL("./fixtures/deal-pictures.pdf", import.meta.url)),
  })).json();
  const id = imp.list.id;
  assert.equal(imp.list.images.state, "pending");
  await jobs.idle();
  const lists = (await (await admin("/api/admin/lists")).json()).lists;
  const l = lists.find((x) => x.id === id);
  assert.equal(l.images.state, "done");
  assert.equal(l.stats.pictures, 5);

  await admin(`/api/admin/lists/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ published: true }) });
  const deals = (await (await fetch(`${base}/api/deals?list=${id}`)).json()).items;
  const d2 = deals.find((d) => d.stt === 2), d5 = deals.find((d) => d.stt === 5);
  assert.match(d2.image, new RegExp(`^/img/${id}/${d2.id}-p\\.webp$`));
  assert.ok(d2.giftImage);
  assert.equal(d5.image, null);
  const res = await fetch(base + d2.image);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/webp");
  assert.equal((await fetch(`${base}/img/${id}/999999-p.webp`)).status, 404);

  await admin(`/api/admin/lists/${id}`, { method: "DELETE" });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!existsSync(path.join(dir, String(id))), "pictures deleted with the list");
});
