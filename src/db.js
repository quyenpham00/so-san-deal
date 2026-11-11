// SQLite storage (node:sqlite, built into Node 22) + an in-memory cache of enriched deals.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { parsePrice } from "./parser/table.js";
import { enrich } from "./deals.js";

const MIGRATIONS = [
  `CREATE TABLE deal_lists (
     id             INTEGER PRIMARY KEY,
     title          TEXT    NOT NULL,
     session        TEXT    NOT NULL DEFAULT '',
     source         TEXT    NOT NULL DEFAULT '',
     voucher_labels TEXT    NOT NULL DEFAULT '[]',
     published      INTEGER NOT NULL DEFAULT 0,
     pinned         INTEGER NOT NULL DEFAULT 0,
     position       INTEGER NOT NULL DEFAULT 0,
     created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
     updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
   );
   CREATE TABLE deals (
     id          INTEGER PRIMARY KEY,
     list_id     INTEGER NOT NULL REFERENCES deal_lists(id) ON DELETE CASCADE,
     stt         INTEGER NOT NULL,
     brand       TEXT    NOT NULL DEFAULT '',
     name        TEXT    NOT NULL DEFAULT '',
     gift        TEXT    NOT NULL DEFAULT '',
     note        TEXT    NOT NULL DEFAULT '',
     live_raw    TEXT    NOT NULL DEFAULT '',
     live        INTEGER,
     orig_raw    TEXT    NOT NULL DEFAULT '',
     orig        INTEGER,
     voucher_raw TEXT    NOT NULL DEFAULT '[]',
     voucher     TEXT    NOT NULL DEFAULT '[]',
     page        INTEGER
   );
   CREATE INDEX deals_by_list ON deals(list_id, stt);`,
  // v2: prices announced after import (admin-set or reported by viewers)
  `ALTER TABLE deals ADD COLUMN official_price INTEGER;
   ALTER TABLE deals ADD COLUMN official_at TEXT;
   ALTER TABLE deal_lists ADD COLUMN reports_open INTEGER NOT NULL DEFAULT 1;
   CREATE TABLE price_reports (
     id          INTEGER PRIMARY KEY,
     deal_id     INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
     list_id     INTEGER NOT NULL REFERENCES deal_lists(id) ON DELETE CASCADE,
     price       INTEGER NOT NULL,
     reporter    TEXT    NOT NULL,           -- HMAC of the browser's random id
     ip_hash     TEXT    NOT NULL,           -- HMAC of the IP (never the IP itself)
     source      TEXT    NOT NULL DEFAULT '',
     status      TEXT    NOT NULL DEFAULT 'active',  -- active | rejected
     created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
     UNIQUE (deal_id, reporter)
   );
   CREATE INDEX reports_by_list ON price_reports(list_id, status);
   CREATE INDEX reports_by_ip ON price_reports(ip_hash, created_at);
   CREATE TABLE blocked_reporters (
     key        TEXT PRIMARY KEY,            -- a reporter hash or an ip hash
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
   );`,
  // v3: product / gift pictures cut out of the file (bit 1 = product, bit 2 = gift)
  `ALTER TABLE deals ADD COLUMN images INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE deal_lists ADD COLUMN images_state TEXT NOT NULL DEFAULT 'none';  -- none | pending | done | failed
   ALTER TABLE deal_lists ADD COLUMN images_done INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE deal_lists ADD COLUMN images_total INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE deal_lists ADD COLUMN images_error TEXT NOT NULL DEFAULT '';`,
];

export const REPORT_LIMITS = {
  perIpPer10Min: 60, // reports from one IP in 10 minutes
  reportersPerDealPerIp: 3, // different browsers on one IP that may report the same deal
};

export function openDb(file = process.env.DB_PATH || "data/so-san-deal.db", { confirmVotes = Number(process.env.CONFIRM_VOTES) || 2 } = {}) {
  if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  const { user_version: version } = db.prepare("PRAGMA user_version").get();
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return new Store(db, { confirmVotes });
}

/** Group a deal's active reports into price candidates and decide whether one is confirmed. */
export function consensus(candidates, confirmVotes) {
  const sorted = candidates.slice().sort((a, b) => b.votes - a.votes || b.lastAt.localeCompare(a.lastAt));
  const [top, second] = sorted;
  const confirmed = top && top.votes >= confirmVotes && (!second || top.votes > second.votes) ? top : null;
  return { candidates: sorted, confirmed, conflict: Boolean(second && top.votes === second.votes && top.votes >= confirmVotes) };
}

const listFromRow = (r) => ({
  id: r.id,
  title: r.title,
  session: r.session,
  source: r.source,
  voucherLabels: JSON.parse(r.voucher_labels),
  published: Boolean(r.published),
  pinned: Boolean(r.pinned),
  position: r.position,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  dealCount: r.deal_count ?? 0,
  reportsOpen: Boolean(r.reports_open ?? 1),
  images: { state: r.images_state ?? "none", done: r.images_done ?? 0, total: r.images_total ?? 0, error: r.images_error ?? "" },
});

export class Store {
  constructor(db, { confirmVotes = 2 } = {}) {
    this.db = db;
    this.confirmVotes = confirmVotes;
    this.cache = new Map(); // listId → enriched deals
  }

  close() {
    this.db.close();
  }

  tx(fn) {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  lists({ publishedOnly = false } = {}) {
    const rows = this.db
      .prepare(
        `SELECT l.*, (SELECT COUNT(*) FROM deals d WHERE d.list_id = l.id) AS deal_count
           FROM deal_lists l ${publishedOnly ? "WHERE l.published = 1" : ""}
          ORDER BY l.position, l.id DESC`,
      )
      .all();
    return rows.map(listFromRow);
  }

  list(id) {
    const r = this.db
      .prepare(`SELECT l.*, (SELECT COUNT(*) FROM deals d WHERE d.list_id = l.id) AS deal_count FROM deal_lists l WHERE l.id = ?`)
      .get(Number(id));
    return r ? listFromRow(r) : null;
  }

  /** Insert a parsed file as a new (unpublished) list at the top. Returns the list. */
  createList({ title, session = "", source = "", voucherLabels = [], rows, published = false, pinned = false }) {
    return this.tx(() => {
      this.db.prepare("UPDATE deal_lists SET position = position + 1").run();
      const { lastInsertRowid } = this.db
        .prepare(`INSERT INTO deal_lists (title, session, source, voucher_labels, published, pinned, position) VALUES (?, ?, ?, ?, ?, ?, 0)`)
        .run(title, session, source, JSON.stringify(voucherLabels), published ? 1 : 0, pinned ? 1 : 0);
      const listId = Number(lastInsertRowid);
      const ins = this.db.prepare(
        `INSERT INTO deals (list_id, stt, brand, name, gift, note, live_raw, live, orig_raw, orig, voucher_raw, voucher, page)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) {
        const vRaw = r.voucherRaw || [];
        ins.run(
          listId, r.stt, r.brand || "", r.name || "", r.gift || "", r.note || "",
          r.liveRaw || "", parsePrice(r.liveRaw), r.origRaw || "", parsePrice(r.origRaw),
          JSON.stringify(vRaw), JSON.stringify(vRaw.map(parsePrice)), r.page ?? null,
        );
      }
      return this.list(listId);
    });
  }

  updateList(id, patch) {
    const fields = [];
    const vals = [];
    if (typeof patch.title === "string") { fields.push("title = ?"); vals.push(patch.title.trim().slice(0, 200) || "Deal list"); }
    if (typeof patch.published === "boolean") { fields.push("published = ?"); vals.push(patch.published ? 1 : 0); }
    if (typeof patch.pinned === "boolean") { fields.push("pinned = ?"); vals.push(patch.pinned ? 1 : 0); }
    if (typeof patch.reportsOpen === "boolean") { fields.push("reports_open = ?"); vals.push(patch.reportsOpen ? 1 : 0); }
    if (!fields.length) return this.list(id);
    fields.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')");
    const { changes } = this.db.prepare(`UPDATE deal_lists SET ${fields.join(", ")} WHERE id = ?`).run(...vals, Number(id));
    if (!changes) return null;
    this.cache.delete(Number(id)); // title is denormalised into cached deals
    return this.list(id);
  }

  /** ids in the desired order; lists not named keep their relative order after them. */
  reorder(ids) {
    const wanted = ids.map(Number);
    const rest = this.lists().map((l) => l.id).filter((id) => !wanted.includes(id));
    const order = [...wanted, ...rest];
    this.tx(() => {
      const st = this.db.prepare("UPDATE deal_lists SET position = ? WHERE id = ?");
      order.forEach((id, i) => st.run(i, id));
    });
    this.cache.clear();
    return this.lists();
  }

  /** Progress of the picture job of a list (pages done / total). */
  setImagesState(listId, { state, done, total, error }) {
    const sets = [], vals = [];
    if (state != null) { sets.push("images_state = ?"); vals.push(state); }
    if (done != null) { sets.push("images_done = ?"); vals.push(done); }
    if (total != null) { sets.push("images_total = ?"); vals.push(total); }
    if (error != null) { sets.push("images_error = ?"); vals.push(String(error).slice(0, 300)); }
    if (sets.length) this.db.prepare(`UPDATE deal_lists SET ${sets.join(", ")} WHERE id = ?`).run(...vals, Number(listId));
  }

  /** Which pictures each deal has: Map dealId → bit flags (1 product, 2 gift). */
  setDealImages(listId, flags) {
    this.tx(() => {
      const up = this.db.prepare("UPDATE deals SET images = ? WHERE id = ? AND list_id = ?");
      for (const [dealId, f] of flags) up.run(f, Number(dealId), Number(listId));
    });
    this.cache.delete(Number(listId));
  }

  deleteList(id) {
    const { changes } = this.db.prepare("DELETE FROM deal_lists WHERE id = ?").run(Number(id));
    this.cache.delete(Number(id));
    return changes > 0;
  }

  /** Enriched deals of one list (cached). */
  deals(listId) {
    const id = Number(listId);
    if (this.cache.has(id)) return this.cache.get(id);
    const list = this.list(id);
    if (!list) return [];
    // rows were inserted in file order, so id order = the order of the original file
    const rows = this.db.prepare("SELECT * FROM deals WHERE list_id = ? ORDER BY id").all(id);
    const reports = this.reportCandidates(id);
    const out = rows.map((r) => {
      const { candidates, confirmed, conflict } = consensus(reports.get(r.id) || [], this.confirmVotes);
      // The file's own price wins; then an admin-set price; then a price viewers confirmed.
      let announced = null;
      if (r.official_price != null) announced = { price: r.official_price, source: "admin", at: r.official_at };
      else if (confirmed) announced = { price: confirmed.price, source: "community", votes: confirmed.votes, at: confirmed.lastAt };
      return enrich({
        id: r.id,
        listId: id,
        listTitle: list.title,
        listPosition: list.position,
        reportsOpen: list.reportsOpen,
        stt: r.stt,
        brand: r.brand,
        name: r.name,
        gift: r.gift,
        note: r.note,
        liveRaw: r.live_raw,
        fileLive: r.live,
        live: r.live ?? announced?.price ?? null,
        announced: r.live == null ? announced : null,
        candidates: r.live == null ? candidates.slice(0, 3) : [],
        conflict,
        origRaw: r.orig_raw,
        orig: r.orig,
        voucherRaw: JSON.parse(r.voucher_raw),
        voucher: JSON.parse(r.voucher),
        page: r.page,
        images: r.images || 0,
      });
    });
    this.cache.set(id, out);
    return out;
  }

  /** dealId → [{price, votes, lastAt}] from active reports of one list.
   *  A vote is a distinct network (IP hash), so one person with several browsers counts once. */
  reportCandidates(listId) {
    const rows = this.db
      .prepare(
        `SELECT deal_id, price, COUNT(DISTINCT ip_hash) AS votes, MAX(created_at) AS last_at
           FROM price_reports WHERE list_id = ? AND status = 'active'
          GROUP BY deal_id, price`,
      )
      .all(Number(listId));
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.deal_id)) m.set(r.deal_id, []);
      m.get(r.deal_id).push({ price: r.price, votes: r.votes, lastAt: r.last_at });
    }
    return m;
  }

  deal(dealId) {
    const r = this.db.prepare("SELECT id, list_id FROM deals WHERE id = ?").get(Number(dealId));
    return r ? this.deals(r.list_id).find((d) => d.id === r.id) : null;
  }

  isBlocked(...keys) {
    const st = this.db.prepare("SELECT 1 FROM blocked_reporters WHERE key = ?");
    return keys.some((k) => st.get(k));
  }

  /**
   * A viewer reports (or confirms) a price. One active report per browser per deal: a new
   * price from the same browser replaces its old one.
   * @returns {{ok:true, deal:object} | {ok:false, code:string, message:string}}
   */
  reportPrice({ dealId, price, reporter, ipHash, source = "" }) {
    const d = this.deal(dealId);
    const list = d && this.list(d.listId);
    if (!d || !list?.published) return { ok: false, code: "not_found", message: "Không tìm thấy deal." };
    if (!list.reportsOpen) return { ok: false, code: "closed", message: "Deal list này đã tắt báo giá." };
    if (d.fileLive != null) return { ok: false, code: "has_price", message: "Deal này đã có giá trong deal list." };
    if (d.announced?.source === "admin") return { ok: false, code: "official", message: "Giá deal này đã được quản trị viên xác nhận." };
    if (!Number.isInteger(price) || price < 1000 || price > 200_000_000) return { ok: false, code: "bad_price", message: "Giá không hợp lệ." };
    if (this.isBlocked(reporter, ipHash)) return { ok: false, code: "blocked", message: "Bạn tạm thời không thể báo giá." };
    const recent = this.db
      .prepare("SELECT COUNT(*) AS n FROM price_reports WHERE ip_hash = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ','now','-10 minutes')")
      .get(ipHash).n;
    if (recent >= REPORT_LIMITS.perIpPer10Min) return { ok: false, code: "rate_limited", message: "Bạn báo giá nhanh quá, đợi vài phút rồi thử lại." };
    const sameIp = this.db
      .prepare("SELECT COUNT(DISTINCT reporter) AS n FROM price_reports WHERE deal_id = ? AND ip_hash = ? AND reporter <> ?")
      .get(d.id, ipHash, reporter).n;
    if (sameIp >= REPORT_LIMITS.reportersPerDealPerIp) return { ok: false, code: "rate_limited", message: "Deal này đã nhận đủ báo giá từ mạng của bạn." };
    this.db
      .prepare(
        `INSERT INTO price_reports (deal_id, list_id, price, reporter, ip_hash, source) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (deal_id, reporter) DO UPDATE SET price = excluded.price, ip_hash = excluded.ip_hash,
           source = excluded.source, status = 'active', created_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
      )
      .run(d.id, d.listId, price, reporter, ipHash, String(source).slice(0, 300));
    this.cache.delete(d.listId);
    return { ok: true, deal: this.deal(d.id) };
  }

  /** dealId → price this browser reported (for the given deals). */
  myReports(reporter, dealIds) {
    if (!reporter || !dealIds.length) return new Map();
    const rows = this.db
      .prepare(`SELECT deal_id, price FROM price_reports WHERE reporter = ? AND status = 'active' AND deal_id IN (${dealIds.map(() => "?").join(",")})`)
      .all(reporter, ...dealIds.map(Number));
    return new Map(rows.map((r) => [r.deal_id, r.price]));
  }

  /** Admin: set (or clear with null) the official price of a deal. */
  setOfficialPrice(dealId, price) {
    const d = this.deal(dealId);
    if (!d) return null;
    this.db
      .prepare("UPDATE deals SET official_price = ?, official_at = CASE WHEN ? IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%SZ','now') END WHERE id = ?")
      .run(price ?? null, price ?? null, d.id);
    this.cache.delete(d.listId);
    return this.deal(d.id);
  }

  /** Admin: reject every active report of one price on a deal. */
  rejectReports(dealId, price) {
    const d = this.deal(dealId);
    if (!d) return null;
    this.db.prepare("UPDATE price_reports SET status = 'rejected' WHERE deal_id = ? AND price = ? AND status = 'active'").run(d.id, price);
    this.cache.delete(d.listId);
    return this.deal(d.id);
  }

  /** Admin: block everyone who reported this price on this deal, and reject all their reports. */
  blockReportersOf(dealId, price) {
    const rows = this.db.prepare("SELECT DISTINCT reporter, ip_hash FROM price_reports WHERE deal_id = ? AND price = ?").all(Number(dealId), price);
    this.tx(() => {
      const ins = this.db.prepare("INSERT OR IGNORE INTO blocked_reporters (key) VALUES (?)");
      const rej = this.db.prepare("UPDATE price_reports SET status = 'rejected' WHERE reporter = ?");
      for (const r of rows) { ins.run(r.reporter); rej.run(r.reporter); }
    });
    this.cache.clear();
    return rows.length;
  }

  /** Admin review queue: deals with reports or an official price, conflicts first. */
  reviewQueue(listId) {
    const deals = this.deals(listId).filter((d) => d.fileLive == null && (d.candidates.length || d.announced));
    const rank = (d) =>
      d.conflict || (d.announced?.source !== "admin" && d.candidates.length > 1) ? 0
      : !d.announced && d.candidates.length ? 1
      : d.announced?.source === "community" ? 2 : 3;
    return deals.sort((a, b) => rank(a) - rank(b) || a.id - b.id);
  }

  /** Stats for a list card on the home page. */
  stats(listId) {
    const ds = this.deals(listId);
    const byBrand = new Map();
    for (const d of ds) byBrand.set(d.brand, (byBrand.get(d.brand) || 0) + 1);
    return {
      deals: ds.length,
      brands: byBrand.size,
      gifts: ds.filter((d) => d.giftHas).length,
      priced: ds.filter((d) => d.live != null || d.voucher.some((v) => v != null)).length,
      hidden: ds.filter((d) => d.fileLive == null && d.voucher.every((v) => v == null)).length,
      announced: ds.filter((d) => d.announced).length,
      pictures: ds.filter((d) => d.images & 1).length,
      topBrands: [...byBrand].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([b]) => b),
    };
  }
}
