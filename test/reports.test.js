import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb } from "../src/db.js";
import { createApp } from "../src/app.js";
import { parsePriceText } from "../src/priceText.js";

/* ---------- comment parser ---------- */
const DEALS = [
  { id: 30, stt: 30, brand: "Zakka Naturals", name: "COMBO 2 Nước Tẩy Trang Tảo Biển Sea Kelp Micellar Water Zakka Naturals 500ml" },
  { id: 31, stt: 31, brand: "Zakka Naturals", name: "COMBO 2 Nước dưỡng Tảo Biển Sea Kelp Daily Essence Zakka Naturals 150ml" },
  { id: 32, stt: 32, brand: "Zakka Naturals", name: "COMBO 2 Serum Vitamin C GlowFruit+ Brightening Zakka Naturals 20ml" },
  { id: 35, stt: 35, brand: "Emmié", name: "COMBO 2 Hộp 5 Mặt nạ ROSE PDRN+ MASK 25gx10" },
  { id: 39, stt: 39, brand: "Emmié", name: "Máy Hỗ Trợ Làm Sạch Lông IPL XPOWER EM518" },
];
const one = (text) => parsePriceText(text, DEALS).matches.map((m) => [m.stt, m.price, m.status]);

test("comment parser: the shop's usual wording", () => {
  assert.deepEqual(one("STT 30 Combo 2 Nước tẩy trang tảo biển chỉ 215k"), [[30, 215000, "ok"]]);
  assert.deepEqual(one("#35 Hộp 5 mặt nạ 25gx10 giá 99.000đ"), [[35, 99000, "ok"]]);
  assert.deepEqual(one("39. Máy IPL còn 1tr2"), [[39, 1200000, "ok"]]);
  assert.deepEqual(one("STT 39 máy IPL 1,25tr"), [[39, 1250000, "ok"]]);
  assert.deepEqual(one("stt 32 serum vitamin c chỉ 480"), [[32, 480000, "ok"]]);
  assert.deepEqual(one("STT 30-32 đồng giá 199k"), [[30, 199000, "ok"], [31, 199000, "ok"], [32, 199000, "ok"]]);
  assert.deepEqual(one("STT 30, 35 chỉ 150k"), [[30, 150000, "ok"], [35, 150000, "ok"]]);
});

test("comment parser: wrong STT is flagged with the right deal suggested", () => {
  const [m] = parsePriceText("STT 30 Máy IPL làm sạch lông chỉ 1tr890", DEALS).matches;
  assert.equal(m.status, "check");
  assert.equal(m.suggestion.stt, 39);
});

test("comment parser: sizes and percentages are not prices; chatter is reported as unread", () => {
  const r = parsePriceText("STT 35 Mặt nạ 25gx10 giảm 30%\nChúc cả nhà săn deal vui 11.11", DEALS);
  assert.equal(r.matches.length, 0);
  assert.equal(r.unread.length, 2);
});

/* ---------- reports API ---------- */
let server, base, store, adminCookie, listId;
before(async () => {
  store = openDb(":memory:", { confirmVotes: 2 });
  const app = createApp({ store, adminPassword: "pw-123456", sessionSecret: "s" });
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "pw-123456" }) });
  adminCookie = login.headers.get("set-cookie").split(";")[0];
  const imp = await (await fetch(base + "/api/admin/import", {
    method: "POST", headers: { Cookie: adminCookie, "X-Requested-With": "fetch", "X-Filename": "deal.pdf" },
    body: readFileSync(new URL("./fixtures/deal-sample.pdf", import.meta.url)),
  })).json();
  listId = imp.list.id;
  await fetch(base + `/api/admin/lists/${listId}`, { method: "PATCH", headers: { Cookie: adminCookie, "X-Requested-With": "fetch", "Content-Type": "application/json" }, body: JSON.stringify({ published: true }) });
});
after(() => { server.close(); store.close(); });

/** A fake browser that keeps its own cookie, on its own network unless an IP is given.
 *  (Requests come from loopback, which the app trusts to set X-Forwarded-For.) */
let nextIp = 10;
function browser(ip = `203.0.113.${nextIp++}`) {
  let cookie = null;
  return async (path, body) => {
    const res = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { "X-Requested-With": "fetch", "Content-Type": "application/json", "X-Forwarded-For": ip, ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set && set.startsWith("ssd_rid=")) cookie = set.split(";")[0];
    return { status: res.status, body: await res.json() };
  };
}
const dealByStt = async (stt) => (await (await fetch(base + `/api/deals?list=${listId}&limit=500`)).json()).items.find((d) => d.stt === stt);
const admin = (path, method, body) => fetch(base + path, { method, headers: { Cookie: adminCookie, "X-Requested-With": "fetch", "Content-Type": "application/json" }, body: body && JSON.stringify(body) }).then((r) => r.json());

test("a price needs 2 different browsers before it counts", async () => {
  const d3 = await dealByStt(3); // "Giá hấp dẫn" in the sample
  assert.equal(d3.live, null);
  assert.equal(d3.canReport, true);
  const A = browser(), B = browser();

  let r = await A("/api/reports", { dealId: d3.id, price: "215k" });
  assert.equal(r.status, 201);
  assert.equal(r.body.deal.announced, null, "one report is not enough");
  assert.deepEqual(r.body.deal.candidates, [{ price: 215000, votes: 1 }]);

  r = await A("/api/reports", { dealId: d3.id, price: 215000 }); // same browser again: still one vote
  assert.deepEqual(r.body.deal.candidates, [{ price: 215000, votes: 1 }]);

  r = await B("/api/reports", { dealId: d3.id, price: 215000 });
  assert.equal(r.body.deal.announced.price, 215000);
  assert.equal(r.body.deal.announced.source, "community");
  assert.equal(r.body.deal.live, 215000);
  assert.equal(r.body.deal.fileLive, null, "the file still had no price");
  assert.equal(r.body.deal.canReport, true, "a viewer-confirmed price can still be corrected");

  // now it filters and sorts like any priced deal
  const priced = await (await fetch(base + `/api/deals?list=${listId}&priced=1&limit=500`)).json();
  assert.ok(priced.items.some((d) => d.id === d3.id));
  const need = await (await fetch(base + `/api/deals?list=${listId}&needPrice=1&limit=500`)).json();
  assert.ok(!need.items.some((d) => d.id === d3.id));

  // the reporting browser sees its own report
  const mine = (await A(`/api/deals?list=${listId}&limit=500`)).body.items.find((d) => d.id === d3.id);
  assert.equal(mine.mine, 215000);
});

test("deals that already have a price in the file can't be reported", async () => {
  const d1 = await dealByStt(1);
  const r = await browser()("/api/reports", { dealId: d1.id, price: 1000 });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "has_price");
});

test("one network counts as one vote, and can't flood a deal", async () => {
  const d6 = await dealByStt(6);
  const results = [];
  let last;
  for (let i = 0; i < 5; i++) {
    last = await browser("198.51.100.7")("/api/reports", { dealId: d6.id, price: 99000 });
    results.push(last.status);
  }
  assert.deepEqual(results, [201, 201, 201, 429, 429], "3 browsers from one IP may report a deal, then it is refused");
  assert.equal((await dealByStt(6)).announced, null, "3 browsers on one network are still one vote");
  assert.deepEqual((await dealByStt(6)).candidates, [{ price: 99000, votes: 1 }]);
});

test("pasting a comment: read, then send as reports", async () => {
  const C = browser(), D = browser();
  const text = "STT 9 Combo dầu tẩy trang chỉ 175k\nSTT 12 giá 88.000đ\nchúc mọi người săn vui";
  const parsed = (await C(`/api/lists/${listId}/price-text`, { text })).body;
  assert.deepEqual(parsed.matches.map((m) => [m.stt, m.price]), [[9, 175000], [12, 88000]]);
  assert.equal(parsed.unread.length, 0, "chatter without digits is ignored");
  const items = parsed.matches.map((m) => ({ dealId: m.dealId, price: m.price }));
  assert.equal((await C("/api/reports/bulk", { items })).body.saved, 2);
  assert.equal((await D("/api/reports/bulk", { items })).body.saved, 2);
  assert.equal((await dealByStt(9)).announced.price, 175000);
});

test("admin: review queue, official price wins, reject and block", async () => {
  const d15 = await dealByStt(15);
  const [A, B] = [browser(), browser()];
  await A("/api/reports", { dealId: d15.id, price: 300000 });
  await B("/api/reports", { dealId: d15.id, price: 310000 });

  let q = await admin(`/api/admin/lists/${listId}/reviews`, "GET");
  const item = q.items.find((i) => i.id === d15.id);
  assert.equal(item.candidates.length, 2);
  assert.equal(q.items[0].announced, null, "unresolved deals come first");

  await admin(`/api/admin/deals/${d15.id}/price`, "PUT", { price: "305k" });
  let d = await dealByStt(15);
  assert.equal(d.announced.source, "admin");
  assert.equal(d.live, 305000);
  assert.equal(d.canReport, false);
  assert.equal((await A("/api/reports", { dealId: d15.id, price: 1000000 })).body.code, "official");

  await admin(`/api/admin/deals/${d15.id}/price`, "PUT", { price: null });
  await admin(`/api/admin/deals/${d15.id}/reject`, "POST", { price: 310000 });
  d = await dealByStt(15);
  assert.deepEqual(d.candidates, [{ price: 300000, votes: 1 }]);

  const blocked = await admin(`/api/admin/deals/${d15.id}/block`, "POST", { price: 300000 });
  assert.equal(blocked.blocked, 1);
  assert.equal((await A("/api/reports", { dealId: (await dealByStt(18)).id, price: 50000 })).body.code, "blocked");
});

test("closing reports for a list", async () => {
  await admin(`/api/admin/lists/${listId}`, "PATCH", { reportsOpen: false });
  const d = await dealByStt(21);
  assert.equal(d.canReport, false);
  assert.equal((await browser()("/api/reports", { dealId: d.id, price: 50000 })).body.code, "closed");
  await admin(`/api/admin/lists/${listId}`, "PATCH", { reportsOpen: true });
});

test("public writes without the X-Requested-With header are refused", async () => {
  const r = await fetch(base + "/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dealId: 1, price: 1000 }) });
  assert.equal(r.status, 403);
});
