// Regenerates test/fixtures/deal-pictures.pdf: a 6-row deal list with real embedded pictures,
// for the picture-extraction test. Each product picture is a block of one colour, so the test
// can tell which picture landed in which deal.
// - rows 1, 2, 4, 6: one product picture (rows 2 and 6 also have a gift picture)
// - row 3: two pictures with a "+" between them (a combo), drawn as one thumbnail
// - row 5: no picture
// Usage: node test/fixtures/make-pictures-pdf.js "<path to chrome.exe or msedge.exe>"
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import sharp from "sharp";

const dir = path.dirname(fileURLToPath(import.meta.url));
const browser = process.argv[2] || "C:/Program Files/Google/Chrome/Application/chrome.exe";

export const PICTURES = {
  1: { p: [220, 40, 40] },
  2: { p: [40, 160, 60], g: [240, 200, 20] },
  3: { p: [40, 80, 220], combo: true },
  4: { p: [150, 60, 180] },
  5: {},
  6: { p: [230, 120, 30], g: [20, 170, 190] },
};

const png = async ([r, g, b], w = 120, h = 90) =>
  "data:image/png;base64," + (await sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } }).png().toBuffer()).toString("base64");

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let rows = "";
  for (let i = 1; i <= 6; i++) {
    const pic = PICTURES[i];
    const prod = !pic.p ? "" : pic.combo
      ? `<img src="${await png(pic.p, 50, 90)}"><b class="plus">+</b><img src="${await png(pic.p, 50, 90)}">`
      : `<img src="${await png(pic.p)}">`;
    const gift = pic.g ? `<img src="${await png(pic.g, 80, 80)}">` : "";
    rows += `<tr><td>${i}</td><td class="b">Brand ${String.fromCharCode(64 + i)}</td><td class="n">Sản phẩm số ${i} 100ml</td>
      <td class="pic">${prod}</td><td>${(100 + i * 10).toLocaleString("de-DE")}.000</td><td class="y">${(70 + i * 7).toLocaleString("de-DE")}.000</td>
      <td>${pic.g ? "1 Túi quà xinh" : ""}</td><td class="pic">${gift}</td></tr>`;
  }
  const html = `<!doctype html><meta charset="utf-8"><style>
    @page{size:A4;margin:18mm 12mm} body{font-family:"Times New Roman";font-size:7pt}
    .hd{display:flex;justify-content:space-between;font-family:Arial;font-size:9pt}
    table{border-collapse:collapse;width:100%;margin-top:4mm} td,th{border:1px solid #000;padding:2px 4px;text-align:center}
    th{background:#f28c3a} .y{background:yellow;color:red;font-weight:bold} td.n{text-align:left;width:30%} td.b{font-weight:bold;width:10%}
    td.pic{width:16%;height:70px} td.pic img{height:60px;vertical-align:middle} .plus{color:red;margin:0 4px}
  </style>
  <div class="hd"><span>SUPERLIVE 20H 11/11</span><span>ID: TEST</span></div>
  <table><tr><th>STT</th><th>BRAND</th><th>Tên sản phẩm</th><th>Hình ảnh</th><th>Giá livestream</th>
    <th class="y">Giá sau voucher 30%</th><th>Quà tặng</th><th>Hình ảnh quà tặng</th></tr>${rows}</table>`;
  const htmlPath = path.join(dir, "deal-pictures.html");
  writeFileSync(htmlPath, html);
  execFileSync(browser, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer",
    `--print-to-pdf=${path.join(dir, "deal-pictures.pdf")}`, pathToFileURL(htmlPath).href], { stdio: "ignore" });
  console.log("wrote", path.join(dir, "deal-pictures.pdf"));
}
