// HTTP API + static frontend.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes } from "node:crypto";
import { createAuth } from "./auth.js";
import { searchDeals, publicDeal } from "./deals.js";
import { parseDealFile, UserError } from "./parser/index.js";
import { parsePages } from "./parser/table.js";
import { createDrive } from "./drive.js";
import { createImageStore } from "./images.js";
import { createImageJobs, pictureSource } from "./imageJob.js";
import { parsePriceText, parseMoney } from "./priceText.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const csv = (v) => (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : []);
const num = (v) => (v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const flag = (v) => v === "1" || v === "true";

/**
 * @param {{store: import('./db.js').Store, adminPassword?: string, sessionSecret?: string, secureCookie?: boolean, maxUploadMb?: number, trustProxy?: any, drive?: ReturnType<typeof createDrive>}} opts
 */
export function createApp({ store, adminPassword, sessionSecret, secureCookie = false, maxUploadMb = 40, trustProxy = "loopback", drive, imagesDir = "data/images", imageJobs }) {
  const app = express();
  drive ||= createDrive({ maxBytes: maxUploadMb * 1024 * 1024 });
  const images = createImageStore(imagesDir);
  imageJobs ||= createImageJobs({ store, images });
  const auth = createAuth({ password: adminPassword, secret: sessionSecret, secureCookie });
  app.disable("x-powered-by");
  // Client IPs come from X-Forwarded-For only when the request arrives from a trusted proxy.
  // Default: a reverse proxy on the same machine. Set TRUST_PROXY (e.g. "1" or a subnet) behind other proxies.
  app.set("trust proxy", trustProxy);
  app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    next();
  });
  app.use(express.json({ limit: "200kb" }));

  /* ---------- viewer identity for price reports (no accounts) ----------
     Each browser gets a random id in an HttpOnly cookie; only HMACs of it and of the IP are stored. */
  const hmacKey = sessionSecret || randomBytes(32).toString("hex");
  const hmac = (v) => createHmac("sha256", hmacKey).update(String(v)).digest("base64url").slice(0, 22);
  const RID = "ssd_rid";
  const readRid = (req) => (req.headers.cookie || "").split(";").map((s) => s.trim()).find((s) => s.startsWith(RID + "="))?.slice(RID.length + 1) || null;
  const reporterOf = (req) => { const rid = readRid(req); return rid && /^[A-Za-z0-9_-]{16,64}$/.test(rid) ? hmac("r:" + rid) : null; };
  function ensureReporter(req, res) {
    let rid = readRid(req);
    if (!rid || !/^[A-Za-z0-9_-]{16,64}$/.test(rid)) {
      rid = randomBytes(18).toString("base64url");
      res.append("Set-Cookie", `${RID}=${rid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${400 * 24 * 3600}${secureCookie ? "; Secure" : ""}`);
    }
    return { reporter: hmac("r:" + rid), ipHash: hmac("ip:" + (req.ip || "?")) };
  }
  // Public writes need this header: browsers only send it from our own pages (cross-site needs CORS).
  const sameOrigin = (req, res, next) =>
    req.get("x-requested-with") === "fetch" ? next() : res.status(403).json({ error: "Yêu cầu không hợp lệ." });

  const publicList = (l) => ({
    id: l.id,
    title: l.title,
    session: l.session,
    pinned: l.pinned,
    reportsOpen: l.reportsOpen,
    voucherLabels: l.voucherLabels,
    updatedAt: l.updatedAt,
    stats: store.stats(l.id),
  });
  const visibleList = (req, id) => {
    const l = store.list(id);
    return l && (l.published || auth.isAdmin(req)) ? l : null;
  };

  /* ---------- public ---------- */
  app.get("/api/lists", (req, res) => {
    res.json({ lists: store.lists({ publishedOnly: true }).map(publicList) });
  });

  app.get("/api/lists/:id", (req, res) => {
    const l = store.list(req.params.id);
    if (!l || (!l.published && !auth.isAdmin(req))) return res.status(404).json({ error: "Không tìm thấy deal list." });
    res.json({ list: publicList(l) });
  });

  // list=<id> | all
  app.get("/api/deals", (req, res) => {
    const q = req.query;
    const admin = auth.isAdmin(req);
    const visible = store.lists({ publishedOnly: !admin });
    let scope;
    if (!q.list || q.list === "all") scope = visible.filter((l) => l.published);
    else {
      const l = visible.find((x) => x.id === Number(q.list));
      if (!l) return res.status(404).json({ error: "Không tìm thấy deal list." });
      scope = [l];
    }
    const labels = new Map(scope.map((l) => [l.id, l.voucherLabels]));
    const deals = scope.flatMap((l) => store.deals(l.id));
    const pick = /^(best|live|v\d)$/.test(q.pick || "") ? q.pick : "best";
    const out = searchDeals(
      deals,
      {
        q: String(q.q || "").slice(0, 200),
        brands: csv(q.brands),
        cats: csv(q.cats),
        lists: csv(q.lists),
        ids: csv(q.ids),
        gift: flag(q.gift),
        needPrice: flag(q.needPrice),
        priced: flag(q.priced),
        combo: flag(q.combo),
        group: flag(q.group),
        min: num(q.min),
        max: num(q.max),
        pick,
        sort: q.sort,
        offset: q.offset,
        limit: q.limit,
      },
      (id) => labels.get(id) || [],
    );
    // mark the prices this browser already reported, so the page can show "Bạn đã báo"
    const mine = store.myReports(reporterOf(req), out.items.map((d) => d.id));
    for (const d of out.items) d.mine = mine.get(d.id) ?? null;
    res.json({ ...out, voucherLabels: scope.find((l) => l.voucherLabels.length)?.voucherLabels || [] });
  });

  /* ---------- price reports from viewers ---------- */
  function report(req, res, items, source) {
    const who = ensureReporter(req, res);
    return items.map(({ dealId, price }) => {
      const p = parseMoney(price);
      const r = store.reportPrice({ dealId: Number(dealId), price: p, ...who, source });
      return r.ok
        ? { dealId: Number(dealId), ok: true, deal: { ...publicDeal(r.deal), mine: p } }
        : { dealId: Number(dealId), ok: false, code: r.code, error: r.message };
    });
  }

  // one price: {dealId, price, source?}. Reporting the same price someone else reported = confirming it.
  app.post("/api/reports", sameOrigin, (req, res) => {
    const { dealId, price, source } = req.body || {};
    const [r] = report(req, res, [{ dealId, price }], String(source || "").slice(0, 60));
    if (!r.ok) return res.status(r.code === "not_found" ? 404 : r.code === "rate_limited" ? 429 : 400).json({ error: r.error, code: r.code });
    res.status(201).json(r);
  });

  // many prices from a pasted comment: {items:[{dealId, price}], source?}
  app.post("/api/reports/bulk", sameOrigin, (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 200) : [];
    if (!items.length) return res.status(400).json({ error: "Không có giá nào để gửi." });
    const results = report(req, res, items, String(req.body?.source || "bình luận").slice(0, 60));
    res.json({ results, saved: results.filter((r) => r.ok).length });
  });

  // read prices out of pasted comment text (no saving): {text}
  app.post("/api/lists/:id/price-text", sameOrigin, (req, res) => {
    const l = visibleList(req, req.params.id);
    if (!l) return res.status(404).json({ error: "Không tìm thấy deal list." });
    const text = String(req.body?.text || "").slice(0, 100_000);
    const deals = store.deals(l.id);
    const byId = new Map(deals.map((d) => [d.id, d]));
    const { matches, unread } = parsePriceText(text, deals);
    res.json({
      matches: matches.map((m) => {
        const d = byId.get(m.dealId);
        const s = m.suggestion && byId.get(m.suggestion.id);
        return { ...m, current: d ? { live: d.live, liveRaw: d.liveRaw, announced: d.announced, fileLive: d.fileLive } : null,
          canReport: d ? publicDeal(d).canReport : false,
          suggestion: s ? { ...m.suggestion, canReport: publicDeal(s).canReport, hasPrice: s.fileLive != null } : null };
      }),
      unread,
    });
  });

  /* ---------- admin ---------- */
  app.get("/api/admin/me", (req, res) => res.json({ admin: auth.isAdmin(req), enabled: auth.enabled }));
  app.post("/api/admin/login", (req, res) => auth.login(req, res));
  app.post("/api/admin/logout", (req, res) => auth.logout(req, res));

  const admin = express.Router();
  admin.use(auth.require);

  admin.get("/lists", (req, res) => {
    res.json({ lists: store.lists().map((l) => ({ ...l, stats: store.stats(l.id) })) });
  });

  /** Save parsed rows as a draft list and answer with a preview (shared by file upload and Drive link). */
  function saveImport(res, { parsed, filename, title, source, pictures }) {
    if (!parsed.rows.length) {
      throw new UserError("Không tìm thấy bảng deal trong file. Cần bảng có các cột STT, BRAND, Tên sản phẩm, Giá…", 422);
    }
    title = String(title || filename.replace(/\.[a-z0-9]+$/i, "")).replace(/_+/g, " ").trim().slice(0, 200) || "Deal list";
    let list = store.createList({ title, session: parsed.session, source, voucherLabels: parsed.voucherLabels, rows: parsed.rows });
    // product / gift pictures are cut out in the background; the admin page shows the progress
    if (pictures) { imageJobs.start(list.id, parsed.rows, pictures); list = store.list(list.id); }
    const deals = store.deals(list.id);
    const noPrice = deals.filter((d) => d.live == null && d.voucher.every((v) => v == null)).length;
    const noBrand = deals.filter((d) => !d.brand).length;
    const warnings = [];
    if (!parsed.voucherLabels.length) warnings.push("Không thấy cột giá sau voucher.");
    if (noBrand) warnings.push(`${noBrand} deal không có brand.`);
    res.status(201).json({
      list: { ...list, stats: store.stats(list.id) },
      preview: deals.slice(0, 15).map((d) => ({ stt: d.stt, brand: d.brand, name: d.name, liveRaw: d.liveRaw, voucherRaw: d.voucherRaw, gift: d.gift, page: d.page })),
      hiddenPrice: noPrice,
      warnings,
    });
  }

  // Body: raw file bytes. Header X-Filename: URI-encoded original name.
  admin.post("/import", express.raw({ type: () => true, limit: `${maxUploadMb}mb` }), async (req, res, next) => {
    try {
      const filename = decodeURIComponent(req.get("x-filename") || "deal-list.pdf").slice(0, 200);
      if (!req.body?.length) throw new UserError("File rỗng.");
      const parsed = await parseDealFile(req.body, filename);
      const title = req.get("x-title") ? decodeURIComponent(req.get("x-title")) : "";
      saveImport(res, { parsed, filename, title, source: filename, pictures: pictureSource({ buffer: req.body, filename }) });
    } catch (e) {
      next(e);
    }
  });

  // Body: { url, title? }. A Google Drive file / Google Sheets link is imported as a draft;
  // a folder link answers { folder: [{ id, name, url }] } so the admin can pick a file.
  let driveBusy = 0;
  admin.post("/import-link", async (req, res, next) => {
    try {
      const { url, title } = req.body || {};
      if (driveBusy >= 2) throw new UserError("Đang đọc file Drive khác, thử lại sau ít giây.", 429);
      driveBusy++;
      let got;
      try {
        got = await drive.fetchLink(url);
      } finally {
        driveBusy--;
      }
      if (got.folder) {
        return res.json({
          folder: got.folder.map((f) => ({
            ...f,
            url: f.kind === "sheet" ? `https://docs.google.com/spreadsheets/d/${f.id}/edit` : `https://drive.google.com/file/d/${f.id}/view`,
          })),
        });
      }
      const filename = String(got.filename || "drive-file").slice(0, 200);
      const parsed = got.pages ? parsePages(got.pages) : await parseDealFile(got.buffer, filename);
      saveImport(res, { parsed, filename, title: typeof title === "string" ? title : "", source: `${filename} · Google Drive`, pictures: pictureSource({ ...got, filename }) });
    } catch (e) {
      next(e);
    }
  });

  admin.patch("/lists/:id", (req, res) => {
    const { title, pinned, published, reportsOpen } = req.body || {};
    const l = store.updateList(req.params.id, { title, pinned, published, reportsOpen });
    if (!l) return res.status(404).json({ error: "Không tìm thấy deal list." });
    res.json({ list: { ...l, stats: store.stats(l.id) } });
  });

  admin.post("/lists/reorder", (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.every((x) => Number.isInteger(Number(x)))) {
      return res.status(400).json({ error: "Danh sách id không hợp lệ." });
    }
    res.json({ lists: store.reorder(ids) });
  });

  /* price review */
  const reviewItem = (d) => ({
    id: d.id, stt: d.stt, brand: d.brand, name: d.name, liveRaw: d.liveRaw,
    announced: d.announced, candidates: d.candidates, conflict: d.conflict,
  });
  admin.get("/lists/:id/reviews", (req, res) => {
    const l = store.list(req.params.id);
    if (!l) return res.status(404).json({ error: "Không tìm thấy deal list." });
    const s = store.stats(l.id);
    res.json({ list: { id: l.id, title: l.title, reportsOpen: l.reportsOpen }, stats: { hidden: s.hidden, announced: s.announced }, items: store.reviewQueue(l.id).map(reviewItem) });
  });

  // set ({price}) or clear ({price:null}) the official price of a deal
  admin.put("/deals/:id/price", (req, res) => {
    const raw = req.body?.price;
    const price = raw === null ? null : parseMoney(raw);
    if (raw !== null && (price == null || price < 1000)) return res.status(400).json({ error: "Giá không hợp lệ." });
    const d = store.setOfficialPrice(req.params.id, price);
    if (!d) return res.status(404).json({ error: "Không tìm thấy deal." });
    res.json({ item: reviewItem(d) });
  });

  // many official prices at once (admin pasted a comment): {items:[{dealId, price}]}
  admin.post("/prices", (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 1000) : [];
    let saved = 0;
    for (const it of items) {
      const p = parseMoney(it.price);
      if (p != null && p >= 1000 && store.setOfficialPrice(it.dealId, p)) saved++;
    }
    res.json({ saved });
  });

  admin.post("/deals/:id/reject", (req, res) => {
    const d = store.rejectReports(req.params.id, Number(req.body?.price));
    if (!d) return res.status(404).json({ error: "Không tìm thấy deal." });
    res.json({ item: reviewItem(d) });
  });

  admin.post("/deals/:id/block", (req, res) => {
    const n = store.blockReportersOf(req.params.id, Number(req.body?.price));
    res.json({ blocked: n, item: store.deal(req.params.id) ? reviewItem(store.deal(req.params.id)) : null });
  });

  admin.delete("/lists/:id", (req, res) => {
    if (!store.deleteList(req.params.id)) return res.status(404).json({ error: "Không tìm thấy deal list." });
    images.removeList(req.params.id).catch(() => {});
    res.json({ ok: true });
  });

  app.use("/api/admin", admin);
  app.use("/api", (req, res) => res.status(404).json({ error: "Không có API này." }));

  /* ---------- frontend ---------- */
  // no max-age: browsers revalidate with ETag, so an updated app.js is picked up immediately
  // pictures cut out of deal-list files: /img/<listId>/<dealId>-p.webp
  app.use("/img", express.static(imagesDir, { maxAge: "7d", index: false, fallthrough: false }), (err, req, res, next) => res.status(err.status || 404).end());
  app.use(express.static(publicDir, { extensions: ["html"] }));
  app.get("/admin", (req, res) => res.sendFile(path.join(publicDir, "admin.html")));

  // errors
  app.use((err, req, res, next) => {
    if (err instanceof UserError) return res.status(err.status).json({ error: err.message });
    if (err?.type === "entity.too.large") return res.status(413).json({ error: `File lớn quá (tối đa ${maxUploadMb} MB).` });
    if (err?.name === "InvalidPDFException" || /Invalid PDF/i.test(err?.message || "")) {
      return res.status(422).json({ error: "File PDF bị lỗi hoặc không đọc được." });
    }
    console.error(err);
    res.status(500).json({ error: "Lỗi máy chủ. Thử lại sau." });
  });

  return app;
}
