import { test } from "node:test";
import assert from "node:assert/strict";
import { enrich, priceFor, savingFor, searchDeals } from "../src/deals.js";

const deal = (id, over) =>
  enrich({ id, listId: 1, listPosition: 0, stt: id, brand: "Cocoon", name: "Sản phẩm", gift: "", note: "", liveRaw: "", live: null, origRaw: "", orig: null, voucherRaw: [], voucher: [], page: 1, ...over });

test("categories: accents decide machine vs lipstick", () => {
  assert.deepEqual(deal(1, { name: "Son Mây Đa Năng Cloudtopia 5.3g" }).cats, ["Trang điểm"]);
  assert.deepEqual(deal(2, { name: "Máy Hỗ Trợ Làm Sạch Lông IPL" }).cats, ["Máy & thiết bị"]);
  assert.deepEqual(deal(3, { name: "Mặt nạ Tràm trà Pionin 25g" }).cats, ["Mặt nạ / pad"]);
  assert.deepEqual(deal(4, { name: "Nồi chiên không dầu 4.1L" }).cats, ["Máy & thiết bị"]);
  assert.deepEqual(deal(5, { name: "Thứ gì đó lạ" }).cats, ["Khác"]);
});

test("gift column: 'x' means no gift; combo is detected", () => {
  assert.equal(deal(1, { gift: "x" }).giftHas, false);
  assert.equal(deal(2, { gift: "1 Túi Zip 20 Pad" }).giftHas, true);
  assert.equal(deal(3, { name: "COMBO 02 Gel tắm" }).combo, true);
});

test("price per voucher choice and saving", () => {
  const d = deal(1, { live: 180000, voucher: [126000, 135000] });
  assert.equal(priceFor(d, "best"), 126000);
  assert.equal(priceFor(d, "v1"), 135000);
  assert.equal(priceFor(d, "live"), 180000);
  assert.equal(savingFor(d, "best"), 54000);
  const hidden = deal(2, { liveRaw: "Giá hấp dẫn", voucher: [null, null] });
  assert.equal(priceFor(hidden, "best"), null);
});

test("search: accent-free query, filters, facets that ignore their own filter", () => {
  const deals = [
    deal(1, { brand: "Cocoon", name: "Nước tẩy trang bí đao 500ml", live: 200000, voucher: [140000] }),
    deal(2, { brand: "Cocoon", name: "Gel tắm nghệ 500ml", live: 150000, voucher: [105000], gift: "Túi refill" }),
    deal(3, { brand: "BIBALA", name: "Kem dưỡng 50g", liveRaw: "Giá hấp dẫn", voucher: [null] }),
  ];
  const labels = () => ["Voucher 30%"];
  let r = searchDeals(deals, { q: "tay trang" }, labels);
  assert.equal(r.total, 1);
  assert.equal(r.items[0].id, 1);
  assert.equal(r.items[0].priceLabel, "Voucher 30%");

  r = searchDeals(deals, { brands: ["Cocoon"] }, labels);
  assert.equal(r.total, 2);
  assert.deepEqual(r.facets.brands.map((b) => [b.name, b.count]), [["Cocoon", 2], ["BIBALA", 1]]);

  r = searchDeals(deals, { priced: true, sort: "asc" }, labels);
  assert.deepEqual(r.items.map((d) => d.id), [2, 1]);

  r = searchDeals(deals, { min: 120000, max: 150000 }, labels);
  assert.deepEqual(r.items.map((d) => d.id), [1]);

  r = searchDeals(deals, { gift: true }, labels);
  assert.deepEqual(r.items.map((d) => d.id), [2]);
  assert.equal(r.insights.gifts, 1);

  r = searchDeals(deals, { sort: "save" }, labels);
  assert.equal(r.items[0].id, 1);
  assert.equal(r.insights.topSaving.amount, 60000);
});

test("default order is the file's own row order, even when STT repeats", () => {
  // the shop's file lists 1148, 1149, 1148, 1149 (two pairs of different products)
  const deals = [[11, 1148, "Sữa tắm"], [12, 1149, "Xịt thơm"], [13, 1148, "Tẩy tế bào chết"], [14, 1149, "Combo sữa tắm"]]
    .map(([id, stt, name]) => deal(id, { stt, name }));
  const r = searchDeals(deals.slice().reverse(), { sort: "stt", limit: 10 }, () => []);
  assert.deepEqual(r.items.map((d) => [d.stt, d.name]), [[1148, "Sữa tắm"], [1149, "Xịt thơm"], [1148, "Tẩy tế bào chết"], [1149, "Combo sữa tắm"]]);
});

test("grouped by brand: brands in STT order, deals of a brand in STT order", () => {
  const deals = [[1, "Cocoon"], [2, "BIBALA"], [3, "Cocoon"], [4, "Anessa"], [5, "BIBALA"]].map(([id, brand]) => deal(id, { brand }));
  const r = searchDeals(deals.slice().reverse(), { sort: "stt", group: true, limit: 10 }, () => []);
  assert.deepEqual(r.items.map((d) => `${d.brand} ${d.stt}`), ["Cocoon 1", "Cocoon 3", "BIBALA 2", "BIBALA 5", "Anessa 4"]);
});
