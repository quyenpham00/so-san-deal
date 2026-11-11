// Product and gift pictures from a deal-list file, saved as small WebP thumbnails.
//
// Two sources, both placed by the row geometry the table reader records (row.geom):
// - Drive view-only files: Drive's viewer serves each page as a picture. Each image cell is cut
//   out: find the cell's grid lines around the expected spot, keep what's inside, trim the margin.
// - PDF bytes (uploads, downloadable Drive files): pdf.js gives each embedded image with its
//   position; the images that sit in one cell are drawn together onto one thumbnail.
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { getDocument, OPS, Util } from "pdfjs-dist/legacy/build/pdf.mjs";

export const THUMB = 360; // longest side of a saved picture, px
const KINDS = [["img", "p", 1], ["giftImg", "g", 2]]; // geom column, file suffix, flag bit

/* ---------- storage ---------- */

/** Pictures live in <dir>/<listId>/<dealId>-p.webp (product) and -g.webp (gift). */
export function createImageStore(dir) {
  const listDir = (listId) => path.join(dir, String(Number(listId)));
  return {
    dir,
    async save(listId, dealId, suffix, buf) {
      await mkdir(listDir(listId), { recursive: true });
      await writeFile(path.join(listDir(listId), `${Number(dealId)}-${suffix}.webp`), buf);
    },
    async removeList(listId) {
      await rm(listDir(listId), { recursive: true, force: true });
    },
  };
}

const toWebp = (img) =>
  img.resize(THUMB, THUMB, { fit: "inside", withoutEnlargement: true }).webp({ quality: 78, effort: 4 }).toBuffer();

/* ---------- cutting cells out of a page picture ---------- */

/** A page picture decoded once: grey pixels to look at, colour pixels to cut from. */
export async function loadPage(png) {
  const base = sharp(png).flatten({ background: "#ffffff" });
  const grey = await base.clone().greyscale().raw().toBuffer({ resolveWithObject: true });
  const rgb = await base.clone().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { w: grey.info.width, h: grey.info.height, grey: grey.data, rgb: rgb.data };
}

const DARK = 200; // grid lines are thin grey; anti-aliased they can be fairly light

/**
 * The table's grid lines on a page picture: pixel columns that are dark along most of the
 * table's height, and pixel rows dark along most of the page width. A product photo never
 * spans a whole table, so it can't be mistaken for a border.
 * A line is also thin: light on both sides. (Many photos sharing a left edge make a long dark
 * edge too, but that is dark on one side.)
 * @param yRange [top, bottom] in page pixels covering the table rows
 * @param pxPerUnit page pixels per PDF unit (sets how thick a line can be)
 */
export function findGrid(page, [ya, yb], pxPerUnit = 2) {
  const { w, h, grey } = page;
  const y0 = Math.max(0, Math.floor(ya)), y1 = Math.min(h, Math.ceil(yb));
  const off = Math.ceil(pxPerUnit * 1.5) + 1; // beyond the widest table border
  const g = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 255 : grey[y * w + x]);
  // a line pixel is dark and clearly darker than the pixels a bit beyond it on both sides
  // (relative, so a border under the coloured header row still counts)
  const lineAt = (x, y, dx, dy) => { const c = g(x, y); return c < DARK && g(x - dx, y - dy) > c + 40 && g(x + dx, y + dy) > c + 40; };
  const v = new Uint8Array(w), hz = new Uint8Array(h);
  if (y1 - y0 > 4) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let y = y0; y < y1; y++) if (lineAt(x, y, off, 0)) n++;
      v[x] = n / (y1 - y0) > 0.5 ? 1 : 0;
    }
  }
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) if (lineAt(x, y, 0, off)) n++;
    hz[y] = n / w > 0.5 ? 1 : 0;
  }
  // a line's anti-aliased edge pixels sit next to its dark core: count them as line too
  const grow = (a) => { const b = a.slice(); for (let i = 1; i < a.length - 1; i++) if (a[i - 1] || a[i + 1]) b[i] = 1; return b; };
  return { v: grow(v), h: grow(hz) };
}

/**
 * Cut the picture out of one table cell.
 * @param page   from loadPage()
 * @param grid   from findGrid()
 * @param box    the cell's expected place in page pixels {x0, y0, x1, y1} (y down)
 * @returns WebP buffer, or null when the cell holds no picture
 */
export async function cropCell(page, grid, box) {
  const { w, h, grey } = page;
  const at = (x, y) => grey[y * w + x];
  // the cell = between the nearest grid lines on each side of the expected centre,
  // searching a little beyond the expected box
  const between = (lines, lo, hi, centre, max) => {
    const reach = (hi - lo) * 0.35;
    const c = Math.round(centre);
    let a = Math.max(0, Math.round(lo)), b = Math.min(max, Math.round(hi));
    for (let i = c; i >= Math.max(0, lo - reach); i--) if (lines[i]) { a = i + 1; break; }
    for (let i = c; i < Math.min(max, hi + reach); i++) if (lines[i]) { b = i; break; }
    // step over the rest of a thick / anti-aliased line
    while (a < b && lines[a]) a++;
    while (b > a && lines[b - 1]) b--;
    return [a + 2, b - 2];
  };
  const [cx0, cx1] = between(grid.v, box.x0, box.x1, (box.x0 + box.x1) / 2, w);
  const [cy0, cy1] = between(grid.h, box.y0, box.y1, (box.y0 + box.y1) / 2, h);
  if (cx1 - cx0 < 8 || cy1 - cy0 < 8) return null;

  // the picture = bounding box of what differs from the cell's background
  const corners = [at(cx0, cy0), at(cx1 - 1, cy0), at(cx0, cy1 - 1), at(cx1 - 1, cy1 - 1)].sort((p, q) => p - q);
  const bg = (corners[1] + corners[2]) / 2;
  let bx0 = Infinity, by0 = Infinity, bx1 = -1, by1 = -1, count = 0;
  for (let y = cy0; y < cy1; y++) {
    for (let x = cx0; x < cx1; x++) {
      if (Math.abs(at(x, y) - bg) > 24) {
        count++;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
    }
  }
  const area = (cx1 - cx0) * (cy1 - cy0);
  // nothing there, or only a stray mark (an "x", a dash): no picture
  if (count < area * 0.01 || bx1 - bx0 < 10 || by1 - by0 < 10) return null;
  const pad = 3;
  const left = Math.max(cx0, bx0 - pad), top = Math.max(cy0, by0 - pad);
  const width = Math.min(cx1, bx1 + pad + 1) - left, height = Math.min(cy1, by1 + pad + 1) - top;
  return toWebp(sharp(page.rgb, { raw: { width: w, height: h, channels: 3 } }).extract({ left, top, width, height }));
}

/** Expected pixel box of a row's cell, from its PDF-unit geometry. */
function cellBox(geom, span, pageSize, scale) {
  return { x0: span[0] * scale, x1: Math.min(span[1], pageSize.width) * scale, y0: (pageSize.height - geom.top) * scale, y1: (pageSize.height - geom.bottom) * scale };
}

/**
 * Drive view-only files: cut every row's pictures out of the page pictures.
 * @param rows       parsed rows with .geom, in the same order as `dealIds`
 * @param pages      parsed pages (for width/height in PDF units)
 * @param pagePng    async (pageNo) => PNG buffer of that page
 * @param onPage     (done, total) => void
 * A page whose picture can't be fetched is skipped (its page number goes into out.skipped);
 * if every page fails, the error is thrown.
 * @param onPictures  async (Map dealId → pictures) => void, called after each page
 * @returns Map dealId → { p?: Buffer, g?: Buffer }, with .skipped = [page numbers]
 */
export async function picturesFromPageImages({ rows, dealIds, pages, pagePng, onPage = () => {}, onPictures = async () => {} }) {
  const byPage = new Map();
  rows.forEach((r, i) => {
    if (r.geom && (r.geom.img || r.geom.giftImg)) (byPage.get(r.geom.page) || byPage.set(r.geom.page, []).get(r.geom.page)).push(i);
  });
  const out = new Map();
  out.skipped = [];
  const pageNos = [...byPage.keys()].sort((a, b) => a - b);
  let done = 0, lastError = null;
  // download a few pages ahead while the current one is being cut (one decoded page in memory at a time)
  const AHEAD = 3;
  const fetches = new Map();
  const fetchPage = (k) => {
    if (k < pageNos.length && !fetches.has(k)) {
      const p = pagePng(pageNos[k]);
      p.catch(() => {}); // awaited (and thrown) in order below
      fetches.set(k, p);
    }
  };
  for (let k = 0; k < pageNos.length; k++) {
    const pageNo = pageNos[k];
    for (let j = k; j < k + AHEAD; j++) fetchPage(j);
    let png;
    try {
      png = await fetches.get(k);
    } catch (e) {
      lastError = e;
      out.skipped.push(pageNo);
      onPage(++done, pageNos.length);
      continue;
    } finally {
      fetches.delete(k);
    }
    const size = pages.find((p) => p.page === pageNo) || { width: 595, height: 842 };
    const pic = await loadPage(png);
    const scale = pic.w / size.width;
    const idx = byPage.get(pageNo);
    const grid = findGrid(pic, [
      (size.height - Math.max(...idx.map((i) => rows[i].geom.top))) * scale,
      (size.height - Math.min(...idx.map((i) => rows[i].geom.bottom))) * scale,
    ], scale);
    const pageOut = new Map();
    for (const i of idx) {
      const g = rows[i].geom;
      const got = {};
      for (const [col, suffix] of KINDS) {
        if (!g[col]) continue;
        const buf = await cropCell(pic, grid, cellBox(g, g[col], size, scale));
        if (buf) got[suffix] = buf;
      }
      if (got.p || got.g) { out.set(dealIds[i], got); pageOut.set(dealIds[i], got); }
    }
    await onPictures(pageOut); // each page's pictures are usable right away
    onPage(++done, pageNos.length);
  }
  if (pageNos.length && out.skipped.length === pageNos.length) throw lastError;
  return out;
}

/* ---------- images embedded in a PDF ---------- */

/** pdf.js decoded image → sharp input, drawn upright. */
function imageToSharp(img, flipY) {
  const { width, height, kind, data } = img;
  let rgba;
  if (kind === 3) rgba = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  else {
    rgba = Buffer.alloc(width * height * 4);
    if (kind === 2) {
      for (let i = 0, j = 0; i < width * height; i++, j += 3) {
        rgba[i * 4] = data[j]; rgba[i * 4 + 1] = data[j + 1]; rgba[i * 4 + 2] = data[j + 2]; rgba[i * 4 + 3] = 255;
      }
    } else if (kind === 1) {
      const rowBytes = (width + 7) >> 3;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const v = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
          const i = (y * width + x) * 4;
          rgba[i] = rgba[i + 1] = rgba[i + 2] = v; rgba[i + 3] = 255;
        }
      }
    } else return null;
  }
  const s = sharp(rgba, { raw: { width, height, channels: 4 } });
  return flipY ? s.flip() : s;
}

/** Every image drawn on a page, with its box in PDF units: [{ img, x0, y0, x1, y1, flipY }]. */
async function pageImages(page) {
  const ops = await page.getOperatorList();
  const found = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = Util.transform(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (Array.isArray(args[0]) && args[0].length === 6) ctm = Util.transform(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const img = fn === OPS.paintInlineImageXObject ? args[0] : await getObj(page, args[0]);
      if (!img || !img.data || !img.width || !img.height) continue;
      // an image fills the unit square, mapped by the current transform
      const corners = [[0, 0], [1, 0], [0, 1], [1, 1]];
      const xs = corners.map(([u, v]) => ctm[0] * u + ctm[2] * v + ctm[4]);
      const ys = corners.map(([u, v]) => ctm[1] * u + ctm[3] * v + ctm[5]);
      found.push({ img, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), flipY: ctm[3] < 0 });
    }
  }
  return found;
}
function getObj(page, id) {
  const objs = String(id).startsWith("g_") ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    try { objs.get(id, resolve); } catch { resolve(null); }
    setTimeout(() => resolve(null), 5000);
  });
}

/**
 * PDF bytes: put the embedded images into the rows' picture cells.
 * @returns Map dealId → { p?: Buffer, g?: Buffer }
 */
export async function picturesFromPdf({ buffer, rows, dealIds, onPage = () => {}, onPictures = async () => {} }) {
  const byPage = new Map();
  rows.forEach((r, i) => { if (r.geom) (byPage.get(r.geom.page) || byPage.set(r.geom.page, []).get(r.geom.page)).push(i); });
  const out = new Map();
  const doc = await getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  try {
    const pageNos = [...byPage.keys()].sort((a, b) => a - b);
    let done = 0;
    for (const pageNo of pageNos) {
      const page = await doc.getPage(pageNo);
      const imgs = (await pageImages(page)).filter((m) => m.x1 - m.x0 > 4 && m.y1 - m.y0 > 4);
      // which cell each image is in: its centre inside the row band and the column
      const cells = new Map(); // "rowIndex|suffix" → images
      for (const m of imgs) {
        const cx = (m.x0 + m.x1) / 2, cy = (m.y0 + m.y1) / 2;
        for (const i of byPage.get(pageNo)) {
          const g = rows[i].geom;
          if (cy > g.top || cy < g.bottom) continue;
          for (const [col, suffix] of KINDS) {
            if (g[col] && cx >= g[col][0] && cx < g[col][1]) {
              const k = `${i}|${suffix}`;
              (cells.get(k) || cells.set(k, []).get(k)).push(m);
            }
          }
        }
      }
      const pageOut = new Map();
      for (const [k, list] of cells) {
        const [i, suffix] = k.split("|");
        const buf = await drawCell(list);
        if (!buf) continue;
        const id = dealIds[Number(i)];
        out.set(id, { ...(out.get(id) || {}), [suffix]: buf });
        pageOut.set(id, out.get(id));
      }
      await onPictures(pageOut);
      page.cleanup();
      onPage(++done, pageNos.length);
    }
  } finally {
    await doc.destroy();
  }
  return out;
}

/** Draw the images of one cell where they sit, on white, as one picture. */
async function drawCell(list) {
  const x0 = Math.min(...list.map((m) => m.x0)), x1 = Math.max(...list.map((m) => m.x1));
  const y0 = Math.min(...list.map((m) => m.y0)), y1 = Math.max(...list.map((m) => m.y1));
  const scale = Math.min(4, 900 / Math.max(x1 - x0, y1 - y0)); // px per PDF unit
  const W = Math.max(1, Math.round((x1 - x0) * scale)), H = Math.max(1, Math.round((y1 - y0) * scale));
  const layers = [];
  for (const m of list) {
    const s = imageToSharp(m.img, m.flipY);
    if (!s) continue;
    const w = Math.max(1, Math.round((m.x1 - m.x0) * scale)), h = Math.max(1, Math.round((m.y1 - m.y0) * scale));
    layers.push({ input: await s.resize(w, h, { fit: "fill" }).png().toBuffer(), left: Math.round((m.x0 - x0) * scale), top: Math.round((y1 - m.y1) * scale) });
  }
  if (!layers.length) return null;
  const canvas = await sharp({ create: { width: W, height: H, channels: 3, background: "#ffffff" } }).composite(layers).png().toBuffer();
  return toWebp(sharp(canvas));
}
