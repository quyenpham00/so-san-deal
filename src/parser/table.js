// Turns the text layer of a deal-list PDF (or a spreadsheet) into deal rows.
// Columns are located from the header row (STT · BRAND · Tên sản phẩm · Giá livestream ·
// Giá sau voucher NN% · Quà tặng …); each row is anchored on its STT number.
import { norm } from "../text.js";

/** "1.890.000" / "180k" / "126,000đ" → number; anything else (e.g. "Giá hấp dẫn") → null */
export function parsePrice(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const c = String(raw ?? "").trim().replace(/\s/g, "").replace(/(vnd|vnđ|đ|d)$/i, "");
  if (!c) return null;
  const m = c.match(/^(\d{1,3}(?:[.,]\d{3})+|\d+)(k)?$/i);
  if (!m) return null;
  let v = Number(m[1].replace(/[.,]/g, ""));
  if (m[2]) v *= 1000;
  return v;
}

/** Header cell text → column key */
export function classifyHeader(text) {
  const n = norm(text).replace(/\s+/g, " ").trim();
  if (!n) return null;
  if (/^(stt|no\.?|#)$/.test(n)) return "stt";
  if (/brand|thuong hieu|nhan hang/.test(n)) return "brand";
  if (/hinh anh qua|anh qua/.test(n)) return "giftImg";
  if (/qua tang|gift|qua kem/.test(n)) return "gift";
  if (/hinh anh|image|anh san pham/.test(n)) return "img";
  if (/voucher|sau ma|sau giam/.test(n)) return "voucher";
  if (/livestream|gia live|gia ban live/.test(n)) return "live";
  if (/gia goc|niem yet|gia ban le|gia thi truong/.test(n)) return "orig";
  if (/ten san pham|san pham|product|ten sp/.test(n)) return "name";
  if (/phan loai|ghi chu|note/.test(n)) return "note";
  return null;
}

function voucherLabel(headerText, index) {
  const m = String(headerText).match(/(\d+\s*%)/);
  return m ? "Voucher " + m[1].replace(/\s/g, "") : "Voucher " + (index + 1);
}

const isSttHeader = (s) => /^\s*(stt|no\.?)\s*$/i.test(s);

/** Group text items into lines, then join items that sit next to each other on a line. */
export function mergeSegments(items) {
  const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const line = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(1.5, it.fs * 0.3));
    if (line) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  const segs = [];
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    let cur = null;
    for (const it of line.items) {
      const gap = cur ? it.x - (cur.x + cur.w) : Infinity;
      if (cur && gap < it.fs * 0.65) {
        // viewer words (with `ord`) are whole words whose boxes touch: always a space between them
        const space = (it.ord != null || gap > it.fs * 0.12) && !/\s$/.test(cur.str) && !/^\s/.test(it.str);
        cur.str += (space ? " " : "") + it.str;
        cur.w = Math.max(cur.w, it.x + it.w - cur.x);
      } else {
        cur = { str: it.str, x: it.x, y: line.y, w: it.w, fs: it.fs };
        segs.push(cur);
      }
    }
  }
  return segs;
}

/**
 * Items are text runs from pdf.js, or single words with `ord` (reading order) from the Google
 * Drive viewer, where the words of a row share one y and only `ord` gives the line order.
 * @param {{page:number, items:{str:string,x:number,y:number,w:number,fs:number,ord?:number}[]}[]} pages
 * @returns {{rows: Deal[], voucherLabels: string[], session: string}}
 */
export function parsePages(pages) {
  const rows = [];
  let cols = null;
  let voucherLabels = [];

  // Text printed above the table header (event title, shop ID) repeats on every page: drop it.
  const furniture = new Set();
  const furnitureWords = new Set();
  for (const { items } of pages) {
    const h = items.find((i) => isSttHeader(i.str));
    if (!h) continue;
    const tol = Math.max(10, h.fs * 2.4);
    const above = items.filter((i) => i.y > h.y + tol);
    const ordered = above.some((i) => i.ord != null);
    // viewer words are joined back into phrases ("SUPERLIVE 20H 11/11") for the session label
    for (const t of ordered ? mergeSegments(above).map((sg) => sg.str) : above.map((i) => i.str)) {
      const s = t.trim();
      if (s.length > 2 && !/^\d+$/.test(s)) furniture.add(s);
    }
    if (ordered) for (const i of above) furnitureWords.add(i.str.trim());
  }
  const candidates = [...furniture].filter((s) => !/^id\s*:/i.test(s));
  const session = candidates.find((s) => /live|phiên|sale|\d{1,2}[/.]\d{1,2}/i.test(s)) || candidates[0] || "";

  for (const { page, items: raw } of pages) {
    const ordered = raw.some((i) => i.ord != null);
    let items = raw.filter((i) => !furniture.has(i.str.trim()) && !/^id\s*:/i.test(i.str.trim()));
    if (ordered && items.length) {
      // single words: drop title words only on the page's top line, not inside product names
      const top = Math.max(...items.map((i) => i.y)) - 2;
      items = items.filter((i) => !(i.y >= top && furnitureWords.has(i.str.trim())));
    }
    if (!items.length) continue;
    const segs = mergeSegments(items);
    const sttHeader = segs.find((s) => isSttHeader(s.str));
    let headerBottom;

    if (sttHeader) {
      const tol = Math.max(10, sttHeader.fs * 2.4);
      const band = segs.filter((s) => Math.abs(s.y - sttHeader.y) <= tol);
      // header cells can wrap over several lines: cluster pieces that overlap horizontally
      const clusters = [];
      for (const s of band.slice().sort((a, b) => a.x - b.x)) {
        const last = clusters[clusters.length - 1];
        if (last && s.x <= last.x1 + 0.5) {
          last.parts.push(s);
          last.x1 = Math.max(last.x1, s.x + s.w);
        } else clusters.push({ x0: s.x, x1: s.x + s.w, parts: [s] });
      }
      const found = clusters
        .map((c) => {
          const text = c.parts.sort((a, b) => b.y - a.y || a.x - b.x).map((p) => p.str.trim()).join(" ");
          return { key: classifyHeader(text), text, cx: (c.x0 + c.x1) / 2 };
        })
        .filter((c) => c.key);
      if (found.some((c) => c.key === "name" || c.key === "brand")) {
        found.sort((a, b) => a.cx - b.cx);
        let vi = 0;
        found.forEach((c, i) => {
          c.lo = i ? (found[i - 1].cx + c.cx) / 2 : -Infinity;
          c.hi = i < found.length - 1 ? (c.cx + found[i + 1].cx) / 2 : Infinity;
          if (c.key === "voucher") {
            c.vi = vi++;
            c.label = voucherLabel(c.text, c.vi);
          }
        });
        cols = found;
        voucherLabels = found.filter((c) => c.key === "voucher").map((c) => c.label);
      }
      headerBottom = Math.min(...band.map((s) => s.y)) - 1;
    } else {
      headerBottom = Math.max(...segs.map((s) => s.y)) + 1; // continuation page without a header
    }
    if (!cols) continue;

    const colOf = (s) => {
      // a cell at a left-aligned column's edge belongs to the first column whose header is to its right
      if (s.edge) return cols.find((c) => c.cx > s.x) || cols[cols.length - 1];
      const cx = s.x + s.w / 2;
      return cols.find((c) => cx >= c.lo && cx < c.hi);
    };
    const sttCol = cols.find((c) => c.key === "stt");
    // viewer words are placed one by one: cells can touch, so a joined run could span two columns
    const body = (ordered ? items : segs).filter((s) => s.y < headerBottom);
    const anchors = body
      .filter((s) => sttCol && /^\d{1,5}$/.test(s.str.trim()) && colOf(s) === sttCol)
      .sort((a, b) => b.y - a.y);
    if (!anchors.length) continue;
    const gaps = anchors.slice(1).map((a, i) => anchors[i].y - a.y).sort((a, b) => a - b);
    const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 30;

    const pageRows = anchors.map((a) => ({ a, cells: {} }));
    for (const s of body) {
      if (anchors.includes(s)) continue;
      const c = colOf(s);
      if (!c || c.key === "stt" || c.key === "img" || c.key === "giftImg") continue;
      let best = null;
      let bestD = Infinity;
      for (const r of pageRows) {
        const d = Math.abs(r.a.y - s.y);
        if (d < bestD) { bestD = d; best = r; }
      }
      // below the last row by more than ~a row height: footer / page number
      if (best === pageRows[pageRows.length - 1] && s.y < best.a.y - median * 0.75) continue;
      const k = c.key === "voucher" ? "v" + c.vi : c.key;
      (best.cells[k] ||= []).push(s);
    }

    // Where each row's image cells are on the page (PDF units, y grows upward), for cropping
    // product / gift pictures later: the row band runs halfway to the neighbouring rows.
    const imgCol = cols.find((c) => c.key === "img");
    const giftImgCol = cols.find((c) => c.key === "giftImg");
    // the first / last column has no neighbour on one side: mirror the other edge around its header's centre
    const span = (c) => {
      if (!c) return null;
      const lo = Number.isFinite(c.lo) ? c.lo : Number.isFinite(c.hi) ? 2 * c.cx - c.hi : 0;
      const hi = Number.isFinite(c.hi) ? c.hi : 2 * c.cx - lo;
      return [lo, hi];
    };
    pageRows.forEach((r, i) => {
      const y = r.a.y;
      const up = i ? (pageRows[i - 1].a.y + y) / 2 : Math.min(headerBottom, y + median / 2);
      const down = i < pageRows.length - 1 ? (y + pageRows[i + 1].a.y) / 2 : y - median / 2;
      r.geom = { page, top: up, bottom: down, img: span(imgCol), giftImg: span(giftImgCol) };
    });

    for (const r of pageRows) {
      const get = (k) =>
        (r.cells[k] || [])
          .sort(ordered ? (a, b) => a.ord - b.ord : (a, b) => b.y - a.y || a.x - b.x)
          .map((s) => s.str.trim())
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      const name = get("name");
      if (!name && !get("brand")) continue;
      rows.push({
        stt: Number(r.a.str.trim()),
        brand: get("brand"),
        name,
        gift: get("gift"),
        liveRaw: get("live"),
        origRaw: get("orig"),
        voucherRaw: voucherLabels.map((_, i) => get("v" + i)),
        note: get("note"),
        page,
        geom: r.geom,
      });
    }
  }
  fillBrands(rows);
  return { rows, voucherLabels, session };
}

/** Rows from a spreadsheet given as an array of arrays (first sheet rows). */
export function parseSheet(aoa) {
  let headerIdx = -1;
  let keys = null;
  for (let i = 0; i < Math.min(aoa.length, 30); i++) {
    const k = (aoa[i] || []).map((c) => classifyHeader(String(c ?? "")));
    if (k.includes("name") || (k.includes("brand") && k.includes("stt"))) {
      headerIdx = i;
      keys = k;
      break;
    }
  }
  if (headerIdx < 0) return { rows: [], voucherLabels: [], session: "" };
  const head = aoa[headerIdx];
  const vIdx = [];
  const voucherLabels = [];
  keys.forEach((k, i) => {
    if (k === "voucher") { voucherLabels.push(voucherLabel(head[i], vIdx.length)); vIdx.push(i); }
  });
  const at = (line, k) => {
    const i = keys.indexOf(k);
    return i < 0 ? "" : String(line[i] ?? "").trim();
  };
  const rows = [];
  let n = 0;
  for (const line of aoa.slice(headerIdx + 1)) {
    const name = at(line, "name");
    if (!name) continue;
    rows.push({
      stt: Number(at(line, "stt")) || ++n,
      brand: at(line, "brand"),
      name,
      gift: at(line, "gift"),
      liveRaw: at(line, "live"),
      origRaw: at(line, "orig"),
      voucherRaw: vIdx.map((i) => String(line[i] ?? "").trim()),
      note: at(line, "note"),
      page: null,
    });
  }
  fillBrands(rows);
  return { rows, voucherLabels, session: "" };
}

// Merged BRAND cells only carry text once: fill the rows below with it.
function fillBrands(rows) {
  let last = "";
  for (const r of rows) {
    if (r.brand) last = r.brand;
    else r.brand = last;
  }
}
