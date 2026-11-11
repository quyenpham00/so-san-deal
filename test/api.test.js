import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb } from "../src/db.js";
import { createApp } from "../src/app.js";

let server, base, store, cookie;
const PASSWORD = "test-password-123";

before(async () => {
  store = openDb(":memory:");
  const app = createApp({ store, adminPassword: PASSWORD, sessionSecret: "test-secret" });
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); store.close(); });

const req = (path, opts = {}) =>
  fetch(base + path, { ...opts, headers: { "X-Requested-With": "fetch", ...(cookie ? { Cookie: cookie } : {}), ...opts.headers } });
const json = async (res) => ({ status: res.status, body: await res.json() });

test("admin routes need a login", async () => {
  const r = await json(await fetch(base + "/api/admin/lists"));
  assert.equal(r.status, 401);
});

test("wrong password is refused, right password sets an HttpOnly cookie", async () => {
  let r = await req("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "nope" }) });
  assert.equal(r.status, 401);
  r = await req("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(r.status, 200);
  const set = r.headers.get("set-cookie");
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  cookie = set.split(";")[0];
  assert.equal((await json(await req("/api/admin/me"))).body.admin, true);
});

test("mutations without the X-Requested-With header are rejected", async () => {
  const r = await fetch(base + "/api/admin/lists/1", { method: "DELETE", headers: { Cookie: cookie } });
  assert.equal(r.status, 403);
});

test("import → draft is hidden → publish + pin → public can browse and filter", async () => {
  const pdf = readFileSync(new URL("./fixtures/deal-sample.pdf", import.meta.url));
  const imp = await json(await req("/api/admin/import", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent("DEAL LIST 11.11.pdf") },
    body: pdf,
  }));
  assert.equal(imp.status, 201);
  assert.equal(imp.body.list.dealCount, 45);
  assert.equal(imp.body.list.published, false);
  assert.equal(imp.body.preview.length, 15);
  const id = imp.body.list.id;

  // draft: not public
  const savedCookie = cookie;
  cookie = null;
  assert.equal((await json(await req("/api/lists"))).body.lists.length, 0);
  assert.equal((await req(`/api/deals?list=${id}`)).status, 404);
  cookie = savedCookie;

  const pub = await json(await req(`/api/admin/lists/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ published: true, pinned: true, title: "Superlive 11.11" }),
  }));
  assert.equal(pub.body.list.pinned, true);

  cookie = null;
  const lists = (await json(await req("/api/lists"))).body.lists;
  assert.equal(lists.length, 1);
  assert.equal(lists[0].title, "Superlive 11.11");
  assert.equal(lists[0].pinned, true);
  assert.equal(lists[0].stats.deals, 45);

  let r = (await json(await req(`/api/deals?list=${id}&limit=10`))).body;
  assert.equal(r.total, 45);
  assert.equal(r.items.length, 10);
  assert.deepEqual(r.voucherLabels, ["Voucher 30%", "Voucher 25%"]);

  r = (await json(await req(`/api/deals?list=all&q=${encodeURIComponent("noi chien")}`))).body;
  assert.ok(r.total > 0);
  assert.ok(r.items.every((d) => /Nồi chiên/.test(d.name)));

  r = (await json(await req(`/api/deals?list=${id}&brands=Cocoon&priced=1&pick=v1&sort=asc`))).body;
  assert.ok(r.items.every((d) => d.brand === "Cocoon" && d.price != null));
  assert.ok(r.items.every((d, i, a) => i === 0 || a[i - 1].price <= d.price));
  assert.ok(r.items.every((d) => d.priceLabel === "Voucher 25%"));
  cookie = savedCookie;
});

test("reorder and delete", async () => {
  const csv = Buffer.from("STT,BRAND,Tên sản phẩm,Giá livestream,Giá sau voucher 20%\n1,Cocoon,Gel tắm,200.000,160.000\n");
  const a = (await json(await req("/api/admin/import", { method: "POST", headers: { "X-Filename": "list-b.csv" }, body: csv }))).body.list;
  let lists = (await json(await req("/api/admin/lists"))).body.lists;
  assert.equal(lists[0].id, a.id, "new imports go to the top");
  const ids = lists.map((l) => l.id).reverse();
  lists = (await json(await req("/api/admin/lists/reorder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) }))).body.lists;
  assert.deepEqual(lists.map((l) => l.id), ids);
  assert.equal((await req(`/api/admin/lists/${a.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await req(`/api/admin/lists/${a.id}`, { method: "DELETE" })).status, 404);
});

test("a file without a deal table gets a 422 with a message", async () => {
  const r = await json(await req("/api/admin/import", { method: "POST", headers: { "X-Filename": "empty.csv" }, body: Buffer.from("a,b\n1,2\n") }));
  assert.equal(r.status, 422);
  assert.match(r.body.error, /Không tìm thấy bảng deal/);
});

test("pages are served with a strict CSP", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal((await fetch(base + "/admin")).status, 200);
});
