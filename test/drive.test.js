import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDriveLink, createDrive, viewerPages } from "../src/drive.js";
import { parsePages } from "../src/parser/table.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/app.js";

const FILE = "1ziWP-nTYeCykmKWVYq0NIMwmbso4hDPe";
const NOLOAD = "1noDownloadAllowedXXXXXXXXXXXXXX";
const PRIVATE = "1privateFileXXXXXXXXXXXXXXXXXXXX";
const FOLDER = "15jUDLUdCA3FnRNjbEwtATe7GU0PqJaW-";
const SHEET = "1sheetIdXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

test("Drive links are recognised; other links are refused", () => {
  assert.deepEqual(parseDriveLink(`https://drive.google.com/file/d/${FILE}/view?usp=sharing`), { kind: "file", id: FILE });
  assert.deepEqual(parseDriveLink(`https://drive.google.com/file/u/1/d/${FILE}/view`), { kind: "file", id: FILE });
  assert.deepEqual(parseDriveLink(`https://drive.google.com/open?id=${FILE}`), { kind: "file", id: FILE });
  assert.deepEqual(parseDriveLink(`https://drive.google.com/uc?export=download&id=${FILE}`), { kind: "file", id: FILE });
  assert.deepEqual(parseDriveLink(`https://drive.google.com/drive/folders/${FOLDER}?fbclid=abc`), { kind: "folder", id: FOLDER });
  assert.deepEqual(parseDriveLink(`https://drive.google.com/drive/u/0/folders/${FOLDER}`), { kind: "folder", id: FOLDER });
  assert.deepEqual(parseDriveLink(`https://docs.google.com/spreadsheets/d/${SHEET}/edit#gid=0`), { kind: "sheet", id: SHEET });
  for (const bad of ["", "not a link", "http://drive.google.com/file/d/x/view", "https://evil.example/file/d/abc/view",
    "https://drive.google.com.evil.example/file/d/abc/view", "https://docs.google.com/document/d/abc/edit"]) {
    assert.throws(() => parseDriveLink(bad), { name: "Error" }, bad);
  }
});

/* ---------- a fake Google Drive ---------- */
// Drive viewer text for one page: rows of [[top, left, height, width], "word"], cell by cell.
const W = (t, h, words) => [[t, words[0][0], h, 400], [[[t, words[0][0], h, 400], words.map(([l, w, s]) => [[t, l, h, w], s])]]];
const PAGE = [72, 595, 842, [
  W(22, 10, [[21, 56, "SUPERLIVE"], [78, 20, "20H"], [99, 23, "11/11"]]),
  W(66, 13, [[54, 13, "STT"], [88, 21, "BRAND"], [170, 12, "Tên"], [180, 10, "sản"], [189, 16, "phẩm"],
    [312, 11, "Giá"], [321, 26, "livestream"], [355, 11, "Giá"], [364, 11, "sau"], [373, 21, "voucher"], [368, 14, "30%"],
    [464, 12, "Quà"], [474, 13, "tặng"]]),
  // brand cell touches the name cell ("Store" ends where "BỘ" starts); the name wraps onto 2 lines
  W(91, 18, [[58, 5, "1"], [71, 24, "Amortals"], [93, 20, "Official"], [112, 14, "Store"], [126, 10, "BỘ"], [135, 5, "3"],
    [139, 14, "Bông"], [152, 12, "Mút"], [126, 22, "Rubycell"], [146, 12, "Dày"], [156, 16, "20mm"],
    [319, 20, "199.000"], [365, 20, "139.300"], [450, 10, "Túi"], [459, 12, "quà"]]),
  W(120, 18, [[58, 5, "2"], [89, 20, "Cocoon"], [126, 11, "Gel"], [137, 12, "tắm"], [148, 14, "nghệ"], [126, 16, "500ml"],
    [314, 11, "Giá"], [324, 11, "hấp"], [334, 11, "dẫn"], [360, 11, "Giá"], [369, 11, "hấp"], [379, 11, "dẫn"]]),
  W(149, 18, [[58, 5, "3"], [89, 20, "Cocoon"], [126, 18, "COMBO"], [143, 7, "2"], [150, 17, "Sữa"], [126, 14, "tắm"], [139, 19, "200ml"],
    [319, 20, "250.000"], [365, 20, "175.000"]]),
  W(178, 9, [[58, 5, "4"], [89, 20, "Cocoon"], [126, 14, "Toner"], [319, 20, "120.000"], [365, 20, "84.000"]]),
  W(811, 10, [[293, 6, "1"]]),
]];

const pdfBytes = readFileSync(new URL("./fixtures/deal-sample.pdf", import.meta.url));
function fakeGoogle() {
  const calls = [];
  const html = (body, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
  const json = (o) => new Response(")]}'\n" + JSON.stringify(o), { headers: { "Content-Type": "application/json" } });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(u.hostname + u.pathname);
    const id = u.searchParams.get("id");
    if (u.hostname === "drive.usercontent.google.com" && u.pathname === "/download") {
      if (id === FILE) {
        return new Response(pdfBytes, { headers: { "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename=\"x.pdf\"; filename*=UTF-8''Deal%20m%E1%BA%ABu.pdf" } });
      }
      if (id === PRIVATE) return html("<title>Sign in</title>");
      return html("<p class=\"uc-error-caption\">Sorry, the owner hasn&#39;t given you permission to download this file.</p>");
    }
    if (u.pathname === `/file/d/${NOLOAD}/view`) {
      return html(`<meta property="og:title" content="DEAL LIST 11.11 - H&#192; LINH.pdf"><script>x=["https://drive.google.com/viewer/upload?ds\\u003dAPzn\\u0026ck\\u003d1"]</script>`);
    }
    if (u.pathname === `/file/d/${PRIVATE}/view`) return html("<title>Sign in</title>", 401);
    if (u.pathname === "/viewer/upload") {
      assert.equal(init.method, "POST");
      return json({ meta: "meta?id=TOKEN&dsmi=x", presspage: "presspage?id=TOKEN&dsmi=x" });
    }
    if (u.pathname === "/viewer/meta") return json({ pages: 1 });
    if (u.pathname === "/viewer/presspage") return json(PAGE);
    if (u.pathname === "/embeddedfolderview") {
      return html(`<div class="flip-entries">
        <div class="flip-entry" id="entry-${FILE}"><div class="flip-entry-info"><a href="https://drive.google.com/file/d/${FILE}/view?usp=drive_web"><div class="flip-entry-title">DEAL LIST 11.11.pdf</div></a></div></div>
        <div class="flip-entry" id="entry-abcdefghijkl"><div class="flip-entry-info"><a href="https://drive.google.com/file/d/abcdefghijkl/view"><div class="flip-entry-title">banner.jpg</div></a></div></div>
        <div class="flip-entry" id="entry-${SHEET}"><div class="flip-entry-info"><a href="https://docs.google.com/spreadsheets/d/${SHEET}/edit?usp=drive_web"><div class="flip-entry-title">Deal 12.12</div></a></div></div>
      </div>`);
    }
    return html("not found", 404);
  };
  return { fetch, calls };
}

test("viewer text: cells rebuilt in reading order, touching cells split, wrapped lines kept together", () => {
  const { rows, session, voucherLabels } = parsePages(viewerPages([PAGE]));
  assert.equal(session, "SUPERLIVE 20H 11/11");
  assert.deepEqual(voucherLabels, ["Voucher 30%"]);
  assert.deepEqual(rows.map((r) => [r.stt, r.brand, r.name, r.liveRaw, r.voucherRaw[0], r.gift]), [
    [1, "Amortals Official Store", "BỘ 3 Bông Mút Rubycell Dày 20mm", "199.000", "139.300", "Túi quà"],
    [2, "Cocoon", "Gel tắm nghệ 500ml", "Giá hấp dẫn", "Giá hấp dẫn", ""],
    [3, "Cocoon", "COMBO 2 Sữa tắm 200ml", "250.000", "175.000", ""],
    [4, "Cocoon", "Toner", "120.000", "84.000", ""],
  ]);
});

test("a downloadable file is downloaded; a file with downloads off is read from the viewer", async () => {
  const g = fakeGoogle();
  const drive = createDrive({ fetch: g.fetch });
  const a = await drive.fetchLink(`https://drive.google.com/file/d/${FILE}/view?usp=sharing`);
  assert.equal(a.filename, "Deal mẫu.pdf");
  assert.ok(a.buffer.subarray(0, 5).equals(Buffer.from("%PDF-")));
  assert.ok(!g.calls.some((c) => c.includes("/viewer/")), "no viewer needed");

  const b = await drive.fetchLink(`https://drive.google.com/file/d/${NOLOAD}/view`);
  assert.equal(b.filename, "DEAL LIST 11.11 - HÀ LINH.pdf");
  assert.equal(b.pages.length, 1);
  assert.ok(g.calls.includes("drive.google.com/viewer/presspage"));
  // every request went to Google's own hosts
  assert.ok(g.calls.every((c) => /^(drive|docs|drive\.usercontent)\.google\.com\//.test(c)), g.calls.join(" "));
});

test("private files, oversize files and folders", async () => {
  const g = fakeGoogle();
  await assert.rejects(createDrive({ fetch: g.fetch }).fetchLink(`https://drive.google.com/file/d/${PRIVATE}/view`), /chia sẻ/);
  await assert.rejects(createDrive({ fetch: g.fetch, maxBytes: 1000 }).fetchLink(`https://drive.google.com/file/d/${FILE}/view`), /lớn hơn/);
  const f = await createDrive({ fetch: g.fetch }).fetchLink(`https://drive.google.com/drive/folders/${FOLDER}`);
  assert.deepEqual(f.folder, [
    { id: FILE, name: "DEAL LIST 11.11.pdf", kind: "file" },
    { id: SHEET, name: "Deal 12.12", kind: "sheet" },
  ]);
});

/* ---------- admin API ---------- */
let server, base, store, cookie;
before(async () => {
  store = openDb(":memory:");
  const app = createApp({ store, adminPassword: "pw-123456", sessionSecret: "s", drive: createDrive({ fetch: fakeGoogle().fetch }) });
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "pw-123456" }) });
  cookie = login.headers.get("set-cookie").split(";")[0];
});
after(() => { server.close(); store.close(); });
const importLink = (url, headers = { Cookie: cookie, "X-Requested-With": "fetch" }) =>
  fetch(base + "/api/admin/import-link", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ url }) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));

test("admin imports a Drive link as a draft", async () => {
  let r = await importLink(`https://drive.google.com/file/d/${FILE}/view?usp=sharing`);
  assert.equal(r.status, 201);
  assert.equal(r.body.list.dealCount, 45);
  assert.equal(r.body.list.published, false);
  assert.equal(r.body.list.title, "Deal mẫu");
  assert.equal(r.body.list.source, "Deal mẫu.pdf · Google Drive");

  r = await importLink(`https://drive.google.com/file/d/${NOLOAD}/view`);
  assert.equal(r.status, 201);
  assert.equal(r.body.list.dealCount, 4);
  assert.equal(r.body.list.session, "SUPERLIVE 20H 11/11");

  r = await importLink(`https://drive.google.com/drive/folders/${FOLDER}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.folder.map((f) => f.url), [
    `https://drive.google.com/file/d/${FILE}/view`,
    `https://docs.google.com/spreadsheets/d/${SHEET}/edit`,
  ]);

  r = await importLink("https://example.com/deal.pdf");
  assert.equal(r.status, 400);
});

test("importing a link needs the admin login", async () => {
  const r = await importLink(`https://drive.google.com/file/d/${FILE}/view`, { "X-Requested-With": "fetch" });
  assert.equal(r.status, 401);
});
