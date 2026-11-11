import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDealFile } from "../src/parser/index.js";
import { parsePrice, classifyHeader, parseSheet } from "../src/parser/table.js";
import { expectedRow } from "./fixtures/make-sample-pdf.js";

test("parsePrice handles Vietnamese formats", () => {
  assert.equal(parsePrice("1.890.000"), 1890000);
  assert.equal(parsePrice("126,000đ"), 126000);
  assert.equal(parsePrice("180k"), 180000);
  assert.equal(parsePrice(" 2.700.000 VND"), 2700000);
  assert.equal(parsePrice("Giá hấp dẫn"), null);
  assert.equal(parsePrice(""), null);
  assert.equal(parsePrice(45000), 45000);
});

test("classifyHeader maps the deal-list columns", () => {
  assert.equal(classifyHeader("STT"), "stt");
  assert.equal(classifyHeader("BRAND"), "brand");
  assert.equal(classifyHeader("Tên sản phẩm"), "name");
  assert.equal(classifyHeader("Hình ảnh"), "img");
  assert.equal(classifyHeader("Giá livestream"), "live");
  assert.equal(classifyHeader("Giá sau voucher 30%"), "voucher");
  assert.equal(classifyHeader("Quà tặng"), "gift");
  assert.equal(classifyHeader("Hình ảnh quà tặng"), "giftImg");
});

test("sample PDF: every row, price, voucher and gift is read correctly", async () => {
  const buf = readFileSync(new URL("./fixtures/deal-sample.pdf", import.meta.url));
  const r = await parseDealFile(buf, "deal-sample.pdf");
  assert.deepEqual(r.voucherLabels, ["Voucher 30%", "Voucher 25%"]);
  assert.equal(r.session, "SUPERLIVE 20H 11/11");
  assert.equal(r.rows.length, 45);
  for (const row of r.rows) {
    const e = expectedRow(row.stt);
    assert.equal(row.brand, e.brand, `brand of #${row.stt}`);
    assert.equal(row.name, e.name, `name of #${row.stt}`);
    assert.equal(parsePrice(row.liveRaw), e.live, `live price of #${row.stt}`);
    assert.deepEqual(row.voucherRaw.map(parsePrice), e.v, `voucher prices of #${row.stt}`);
    assert.equal(row.gift, e.gift, `gift of #${row.stt}`);
    assert.ok(!/SUPERLIVE|VHLINH/.test(row.brand + row.name + row.gift), `page header leaked into #${row.stt}`);
  }
  assert.deepEqual([...new Set(r.rows.map((x) => x.page))], [1, 2, 3]);
});

test("spreadsheet rows: header detection and merged brand cells", () => {
  const r = parseSheet([
    ["DEAL LIST 12.12"],
    ["STT", "BRAND", "Tên sản phẩm", "Giá livestream", "Giá sau voucher 20%", "Quà tặng"],
    [1, "Cocoon", "Gel tắm 500ml", "200.000", "160.000", "x"],
    [2, "", "Nước tẩy trang 1000ml", "Giá hấp dẫn", "Giá hấp dẫn", "Bông tẩy trang"],
  ]);
  assert.deepEqual(r.voucherLabels, ["Voucher 20%"]);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[1].brand, "Cocoon");
  assert.equal(r.rows[1].gift, "Bông tẩy trang");
  assert.deepEqual(r.rows[0].voucherRaw, ["160.000"]);
});

test("non-deal file types are rejected with a readable message", async () => {
  await assert.rejects(parseDealFile(Buffer.from("hello"), "notes.txt"), /PDF, Excel/);
});
