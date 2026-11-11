// Regenerates test/fixtures/deal-sample.pdf: a 45-row deal list laid out like the real
// livestream deal lists (event header above the table on every page, two-line voucher
// headers, wrapped names, red "COMBO" prefix, page number at the bottom).
// Usage: node test/fixtures/make-sample-pdf.js "<path to chrome.exe or msedge.exe>"
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const browser = process.argv[2] || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const brands = ["Cocoon", "BIBALA", "Emmié by Happyskin", "Maybelline New York", "Philips Personal Care"];
const names = [
  "COMBO 02 Gel tắm nghệ Hưng Yên Cocoon 500ml",
  "COMBO 04 Túi Refill Tẩy da chết cơ thể đường thốt nốt An Giang Cocoon 200ml",
  "Kem dưỡng làm dịu da, dưỡng ẩm BIBALA SKIN BARRIER CALMING CREAM 20G",
  "Máy Hỗ Trợ Làm Sạch Lông IPL Ice Cooling XPOWER HYPER FLASH EM518",
  "Son Mây Đa Năng Dạng Hũ Cloudtopia Maybelline New York 5.3g (HSD: 9/2028)",
  "Nồi chiên không dầu Philips HD9252 4.1L",
];
const money = (v) => v.toLocaleString("de-DE");

// Expected values are derived from the row number, so tests can check every cell.
export function expectedRow(i) {
  const priced = i % 3 !== 0;
  const live = priced ? 150000 + i * 13000 : null;
  return {
    stt: i,
    brand: brands[Math.floor((i - 1) / 9)],
    name: names[i % names.length] + (i % 7 === 0 ? " Phân loại: Pink, Beige" : ""),
    live,
    v: priced ? [Math.round(live * 0.7), Math.round(live * 0.75)] : [null, null],
    gift: i % 4 === 0 ? "1 Hộp 10 Mask Tencel Hồng 25gx10 + 1 Dung dịch vệ sinh ĐÀO 100ml" : i % 5 === 0 ? "x" : "",
  };
}

function rowHtml(i) {
  const e = expectedRow(i);
  const name = names[i % names.length].replace(/^COMBO (\d+)/, '<span style="color:red;font-weight:bold">COMBO $1</span>');
  const cell = (v) => (v == null ? "Giá hấp dẫn" : money(v));
  return `<tr><td>${i}</td><td class="b">${e.brand}</td><td class="n">${name}${i % 7 === 0 ? "<br><i>Phân loại: Pink, Beige</i>" : ""}</td>
    <td><div class="img"></div></td><td>${cell(e.live)}</td><td class="y">${cell(e.v[0])}</td><td class="y">${cell(e.v[1])}</td>
    <td>${e.gift}</td><td></td></tr>`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const head = `<tr><th>STT</th><th>BRAND</th><th>Tên sản phẩm</th><th>Hình ảnh</th><th>Giá livestream</th>
    <th class="y">Giá sau voucher 30%</th><th class="y">Giá sau voucher 25%</th><th>Quà tặng</th><th>Hình ảnh quà tặng</th></tr>`;
  let pages = "";
  for (let p = 0; p * 18 < 45; p++) {
    const rows = Array.from({ length: Math.min(18, 45 - p * 18) }, (_, k) => rowHtml(p * 18 + k + 1)).join("");
    pages += `<div class="pg"><div class="hd"><span>SUPERLIVE 20H 11/11</span><span>ID: VHLINH.1211</span></div>
      <table>${head}${rows}</table><div class="pn">${p + 1}</div></div>`;
  }
  const html = `<!doctype html><meta charset="utf-8"><style>
    @page{size:A4;margin:18mm 12mm} body{font-family:"Times New Roman";font-size:7pt}
    .pg{page-break-after:always;position:relative;height:255mm}
    .hd{display:flex;justify-content:space-between;font-family:Arial;font-size:9pt}
    .pn{position:absolute;bottom:0;left:0;right:0;text-align:center;font-family:Arial}
    table{border-collapse:collapse;width:100%;margin-top:4mm} td,th{border:1px solid #000;padding:2px 4px;text-align:center}
    th{background:#f28c3a} .y{background:yellow;color:red;font-weight:bold} td.n{text-align:left;width:32%} td.b{font-weight:bold;width:10%}
    .img{width:40px;height:30px;background:#ccc;margin:auto} tr{height:36px}
  </style>${pages}`;
  const htmlPath = path.join(dir, "deal-sample.html");
  writeFileSync(htmlPath, html);
  execFileSync(browser, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer",
    `--print-to-pdf=${path.join(dir, "deal-sample.pdf")}`, pathToFileURL(htmlPath).href], { stdio: "ignore" });
  console.log("wrote", path.join(dir, "deal-sample.pdf"));
}
