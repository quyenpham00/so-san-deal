// Read a deal list straight from a Google Drive / Google Sheets link.
//
// Only links shared as "Anyone with the link" work (no Google login on the server).
// - Downloadable files: the file bytes are downloaded and parsed like an upload.
// - Files whose owner turned off downloading: the PDF's words and positions are read
//   from Drive's own viewer (the text it shows on screen) and fed to the same table reader.
// - Google Sheets: exported as .xlsx.
// - Folders: the files in it are listed so the admin can pick one.
//
// The server only ever requests URLs it builds itself from the file id, on Google's hosts.
import { UserError } from "./parser/index.js";

const ID = /^[\w-]{10,}$/;
const DRIVE_HOSTS = new Set(["drive.google.com", "docs.google.com"]);
const FILE_TYPES = /\.(pdf|xlsx|xls|csv)$/i;

/** Link → { kind: "file" | "sheet" | "folder", id }. Throws UserError for anything else. */
export function parseDriveLink(input) {
  const raw = String(input || "").trim();
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new UserError("Link không hợp lệ. Dán link Google Drive dạng https://drive.google.com/file/d/…");
  }
  if (u.protocol !== "https:" || !DRIVE_HOSTS.has(u.hostname)) {
    throw new UserError("Chỉ nhận link Google Drive hoặc Google Sheets.");
  }
  const p = u.pathname;
  let m;
  if ((m = p.match(/^\/spreadsheets\/(?:u\/\d+\/)?d\/([\w-]+)/))) return { kind: "sheet", id: m[1] };
  if ((m = p.match(/^\/(?:drive\/(?:u\/\d+\/)?)?folders\/([\w-]+)/))) return { kind: "folder", id: m[1] };
  if ((m = p.match(/^\/file\/(?:u\/\d+\/)?d\/([\w-]+)/))) return { kind: "file", id: m[1] };
  const qid = u.searchParams.get("id");
  if (qid && ID.test(qid)) {
    if (/embeddedfolderview/.test(p)) return { kind: "folder", id: qid };
    if (/^\/(open|uc|file)/.test(p)) return { kind: "file", id: qid };
  }
  if ((m = p.match(/^\/(document|presentation)\//))) {
    throw new UserError("Đây là Google Docs/Slides. Cần file PDF, Excel hoặc Google Sheets.");
  }
  throw new UserError("Không nhận ra link. Dán link file (…/file/d/…), Google Sheets (…/spreadsheets/d/…) hoặc thư mục (…/folders/…).");
}

const NOT_SHARED = "Không mở được file. Kiểm tra quyền chia sẻ: \"Bất kỳ ai có đường liên kết\" đều xem được.";

/**
 * @param {{maxBytes?: number, fetch?: typeof fetch, timeoutMs?: number}} [opts]
 */
export function createDrive({ maxBytes = 40 * 1024 * 1024, fetch: fetchImpl = globalThis.fetch, timeoutMs = 60_000, retryMs = 2000 } = {}) {
  const get = (url, init = {}) =>
    fetchImpl(url, {
      redirect: "follow",
      ...init,
      headers: { "User-Agent": "Mozilla/5.0 (deal-list importer)", "Accept-Language": "vi,en;q=0.8", ...(init.headers || {}) },
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((e) => {
      throw new UserError(e?.name === "TimeoutError" ? "Google Drive phản hồi quá lâu, thử lại sau." : "Không kết nối được Google Drive.", 502);
    });

  async function readCapped(res) {
    const len = Number(res.headers.get("content-length") || 0);
    if (len > maxBytes) throw new UserError(`File lớn hơn ${Math.round(maxBytes / 1048576)} MB.`, 413);
    if (!res.body) return Buffer.alloc(0);
    const chunks = [];
    let total = 0;
    for await (const c of res.body) {
      total += c.length;
      if (total > maxBytes) throw new UserError(`File lớn hơn ${Math.round(maxBytes / 1048576)} MB.`, 413);
      chunks.push(Buffer.from(c));
    }
    return Buffer.concat(chunks);
  }

  const isHtml = (res) => /text\/html/i.test(res.headers.get("content-type") || "");
  const loginWall = (res) => /accounts\.google\.com|ServiceLogin/.test(res.url || "");

  /** Folder id → [{ id, name, kind }] of files that can be imported. */
  async function listFolder(id) {
    const res = await get(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(id)}`);
    if (!res.ok || loginWall(res)) throw new UserError(NOT_SHARED, 422);
    const html = await res.text();
    const files = [];
    const re = /<div class="flip-entry" id="entry-([\w-]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?<div class="flip-entry-title">([^<]*)<\/div>/g;
    for (const m of html.matchAll(re)) {
      const name = decodeEntities(m[3]).trim();
      const href = decodeEntities(m[2]);
      if (/\/spreadsheets\//.test(href)) files.push({ id: m[1], name, kind: "sheet" });
      else if (/\/file\/d\//.test(href) && FILE_TYPES.test(name)) files.push({ id: m[1], name, kind: "file" });
    }
    return files;
  }

  /**
   * Fetch a file or sheet. Returns either { buffer, filename } (real file bytes)
   * or { pages, filename } (PDF text read from Drive's viewer, same shape as readPdfPages()).
   */
  async function fetchFile({ kind, id }) {
    if (kind === "sheet") {
      const res = await get(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/export?format=xlsx`);
      if (!res.ok || loginWall(res) || isHtml(res)) throw new UserError(NOT_SHARED, 422);
      return { buffer: await readCapped(res), filename: filenameOf(res) || "Google Sheet.xlsx" };
    }
    // confirm=t skips the "can't scan large files for viruses" page
    const res = await get(`https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`);
    if (res.ok && !isHtml(res) && !loginWall(res)) {
      return { buffer: await readCapped(res), filename: filenameOf(res) || "drive-file" };
    }
    await res.body?.cancel().catch(() => {});
    // Download refused (owner turned it off) or a warning page: read the text the viewer shows.
    return readViewer(id);
  }

  async function readViewer(id) {
    const view = await get(`https://drive.google.com/file/d/${encodeURIComponent(id)}/view`);
    if (!view.ok || loginWall(view)) throw new UserError(NOT_SHARED, 422);
    const html = await view.text();
    const filename = decodeEntities((html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || "").trim() || "drive-file.pdf";
    if (/\.(xlsx|xls|csv)$/i.test(filename)) {
      throw new UserError("Chủ file đã tắt tải xuống nên không đọc được file Excel này. Nhờ chủ file mở tải xuống, hoặc tải file về rồi nhập bằng nút Chọn file.", 422);
    }
    const m = html.match(/"(https:\/\/drive\.google\.com\/viewer\/upload\?[^"]+)"/);
    if (!m) throw new UserError("Không đọc được file này từ Google Drive. Tải file về rồi nhập bằng nút Chọn file.", 422);
    const uploadUrl = JSON.parse(`"${m[1]}"`); // the URL sits in a JS string, with escapes such as \u003d
    if (!uploadUrl.startsWith("https://drive.google.com/viewer/upload?")) throw new UserError("Link Drive không hợp lệ.", 422);

    const base = "https://drive.google.com/viewer/";
    const json = async (res) => {
      if (!res.ok) throw new UserError("Google Drive không trả về nội dung file. Thử lại sau.", 502);
      return JSON.parse((await res.text()).replace(/^\)\]\}'\s*/, ""));
    };
    const paths = await json(await get(uploadUrl, { method: "POST" }));
    const rel = (p) => {
      if (typeof p !== "string" || !/^[a-z]+\?[\w=&%.-]+$/i.test(p)) throw new UserError("Google Drive trả về dữ liệu lạ.", 502);
      return base + p;
    };
    const meta = await json(await get(rel(paths.meta)));
    const count = Math.min(Number(meta.pages) || 0, 1000);
    if (!count) throw new UserError("File không có trang nào đọc được.", 422);

    const pages = new Array(count);
    let next = 0;
    const worker = async () => {
      while (next < count) {
        const i = next++;
        pages[i] = await json(await get(`${rel(paths.presspage)}&page=${i}`));
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, count) }, worker));
    const read = viewerPages(pages);
    if (!read.some((p) => p.items.length)) {
      throw new UserError("File này không có chữ (bản scan/ảnh), không đọc được bảng deal.", 422);
    }
    // page pictures, for cutting out product / gift images afterwards (3200 px wide ≈ 5.4 px per PDF unit)
    // Drive sometimes refuses a burst of page pictures: retry with a growing pause.
    const pagePng = async (pageNo) => {
      let last = "";
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, retryMs * attempt));
        const res = await get(`${rel(paths.img)}&page=${Number(pageNo) - 1}&w=3200`);
        if (res.ok && /^image\//.test(res.headers.get("content-type") || "")) return readCapped(res);
        last = `HTTP ${res.status}`;
        await res.body?.cancel().catch(() => {});
      }
      throw new UserError(`Google Drive không trả về ảnh trang ${pageNo} (${last}).`, 502);
    };
    return { pages: read, filename, pagePng };
  }

  /** Link → { filename, buffer } | { filename, pages } | { folder: [...] } */
  async function fetchLink(url) {
    const link = parseDriveLink(url);
    if (link.kind === "folder") return { folder: await listFolder(link.id) };
    return { link, ...(await fetchFile(link)) };
  }

  return { fetchLink, fetchFile, listFolder };
}

/**
 * One page of Drive viewer text → { page, items } like readPdfPages(): one item per word, in PDF
 * coordinates (y grows upward), with `ord` = reading order.
 * Viewer JSON: [dpi, width, height, nodes]; a node is [[top, left, height, width], string | node[]].
 * All words of a table row share the row's top and height, and come cell by cell, so line order
 * inside a cell is only known from `ord`; the table reader uses it to put cell text back in order.
 * Word boxes include their trailing space, so cells can touch: the reader splits them by column.
 */
export function viewerPage(data, pageNo, wrapStarts = wrapStartsOf([data])) {
  const height = Number(data?.[2]) || 842;
  const groups = viewerGroups(data);
  const near = (x) => Math.round(x);

  // Rebuild cells from reading order: a word that starts left of the previous one is the same
  // cell wrapping onto its next line; a word that touches the previous one continues the line.
  // Word boxes include trailing space, so two neighbouring cells can touch too. Wrapped lines of
  // a left-aligned column all start at its left edge, so a touching word that starts at such an
  // edge (seen as a wrap start 3+ times in the document) begins a new cell.
  const isEdge = (x, slack = 1) => {
    for (let d = -slack; d <= slack; d++) if ((wrapStarts.get(near(x) + d) || 0) >= 3) return true;
    return false;
  };

  const cells = [];
  let ord = 0;
  for (const words of groups) {
    let cur = null;
    for (const w of words) {
      const wraps = cur && w.l < cur.lastL;
      const touches = cur && !wraps && w.l - (cur.lastL + cur.lastW) < 2.5 && !isEdge(w.l);
      if (cur && (wraps || touches)) {
        cur.str += " " + w.s;
        cur.x1 = Math.max(cur.x1, w.l + w.w);
        cur.x0 = Math.min(cur.x0, w.l);
        if (wraps) cur.lines++;
      } else {
        cur = { str: w.s, x0: w.l, x1: w.l + w.w, top: w.t, h: w.h, lines: 1, ord: ord++ };
        cells.push(cur);
      }
      cur.lastL = w.l;
      cur.lastW = w.w;
    }
  }
  // The height given is the whole row's (or a tall merged cell's), not the font size. Estimate the
  // size from text width instead: a character is about half the font size wide.
  let chars = 0, width = 0;
  for (const words of groups) for (const w of words) { chars += [...w.s].length + 1; width += w.w; }
  const fs = chars ? Math.min(14, Math.max(4, (2 * width) / chars)) : 8;

  // `edge`: the cell starts at a left-aligned column's left edge, so the reader places it by that
  // edge rather than its centre (a one-word product name is narrower than its column).
  const items = cells.map((c) => ({ str: c.str, x: c.x0, y: height - c.top - fs, w: c.x1 - c.x0, fs, ord: c.ord, ...(isEdge(c.x0, 3) ? { edge: true } : {}) }));
  return { page: pageNo, width: Number(data?.[1]) || 595, height, items };
}

/** Pages of viewer JSON → pages of items; column edges are learnt from the whole document. */
export function viewerPages(list) {
  const starts = wrapStartsOf(list);
  return list.map((d, i) => viewerPage(d, i + 1, starts));
}

/** x positions (rounded) where a cell's wrapped line starts, with how often: left edges of left-aligned columns. */
function wrapStartsOf(list) {
  const starts = new Map();
  for (const data of list) {
    for (const words of viewerGroups(data)) {
      for (let i = 1; i < words.length; i++) {
        if (words[i].l < words[i - 1].l) {
          const k = Math.round(words[i].l);
          starts.set(k, (starts.get(k) || 0) + 1);
        }
      }
    }
  }
  return starts;
}

/** Viewer JSON → word groups (one per text line node), words in reading order. */
function viewerGroups(data) {
  const groups = [];
  const walk = (node, group) => {
    if (!Array.isArray(node) || !Array.isArray(node[0])) return;
    const [box, content] = node;
    if (typeof content === "string") {
      if (content.trim()) group.push({ t: box[0], l: box[1], h: box[2] || 8, w: box[3] || 0, s: content.trim() });
      return;
    }
    if (!Array.isArray(content)) return;
    if (content.length && content.every((c) => Array.isArray(c) && typeof c[1] === "string")) {
      const words = [];
      for (const c of content) walk(c, words);
      if (words.length) groups.push(words);
    } else for (const c of content) walk(c, group);
  };
  for (const n of data?.[3] || []) walk(n, []);
  return groups;
}

function filenameOf(res) {
  const cd = res.headers.get("content-disposition") || "";
  const star = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {}
  }
  const plain = cd.match(/filename="([^"]+)"/i);
  return plain ? plain[1] : "";
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
