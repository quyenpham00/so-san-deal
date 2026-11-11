// Reads prices out of free-text comments such as
//   "STT 30 Combo 2 Nước tẩy trang tảo biển chỉ 215k"
//   "#31-33 đồng giá 1tr2", "35. Mặt nạ 189.000đ", "STT 40, 41 còn 99k"
// and matches each line to a deal by STT, checking the product name.
import { norm } from "./text.js";

const UNIT_AFTER = /^\s*(ml|g|gr|gram|kg|l|lit|cm|mm|%|x|viên|vien|miếng|mieng|ống|ong|gói|goi|hộp|hop|chai|tuýp|tuyp|cái|cai|pcs|spf)\b/i;
const PRICE_WORD = /(chỉ|chi|giá|gia|còn|con|=|:|deal|sale|đồng giá|dong gia)\s*$/i;

/** Every price-looking token in a line, with its position. */
function priceTokens(line) {
  const out = [];
  // millions: 1tr2, 1,2tr, 1.25 triệu, 1tr250
  const reM = /(\d+(?:[.,]\d+)?)\s*(tr|triệu|trieu|củ|cu)\s*(\d{1,3})?(?![\p{L}\d])/giu;
  for (const m of line.matchAll(reM)) {
    let v = Number(m[1].replace(",", ".")) * 1e6;
    if (m[3]) v += Number(m[3].padEnd(3, "0")) * 1000;
    out.push({ v: Math.round(v), at: m.index, end: m.index + m[0].length, strong: true });
  }
  // thousands: 215k, 215K, 215 nghìn, 215.000, 215.000đ, 1,890,000 vnd, 215đ (rare)
  const reK = /(\d{1,3}(?:[.,]\d{3})+|\d+)\s*(k|nghìn|nghin|ngàn|ngan|đ|d|vnd|vnđ)?(?![\p{L}\d])/giu;
  for (const m of line.matchAll(reK)) {
    if (out.some((t) => m.index >= t.at && m.index < t.end)) continue;
    const after = line.slice(m.index + m[0].length);
    if (UNIT_AFTER.test(after) && !m[2]) continue; // 500ml, 25g, 30%
    const digits = m[1].replace(/[.,]/g, "");
    const grouped = /[.,]\d{3}$/.test(m[1]);
    const unit = (m[2] || "").toLowerCase();
    let v = Number(digits);
    let strong = false;
    if (["k", "nghìn", "nghin", "ngàn", "ngan"].includes(unit)) { v *= 1000; strong = true; }
    else if (grouped && v >= 1000) strong = true;
    else if (unit && v >= 1000) strong = true;
    else if (PRICE_WORD.test(line.slice(0, m.index)) && v >= 10 && v < 10000) { v *= 1000; strong = true; } // "chỉ 215" means 215k
    else if (v >= 10000 && !unit) strong = false; // a bare big number: maybe a price, weak
    else continue;
    out.push({ v, at: m.index, end: m.index + m[0].length, strong });
  }
  return out.filter((t) => t.v >= 1000 && t.v <= 200_000_000).sort((a, b) => a.at - b.at);
}

/** A price typed by a person: "215k", "215.000đ", "1tr2", "1,25 triệu", or "215" (read as 215k). */
export function parseMoney(input) {
  if (typeof input === "number") return Number.isInteger(input) && input >= 1000 ? input : null;
  const s = String(input ?? "").trim();
  if (/^\d{1,4}$/.test(s)) return Number(s) * 1000;
  const t = priceTokens(s).filter((x) => x.strong);
  return t.length === 1 && s.replace(/\s/g, "").length <= 20 ? t[0].v : null;
}

/** STT numbers a line refers to: "STT 30", "#30", "30.", "STT 30-32", "STT 30, 31 & 35". */
function sttRefs(line) {
  const m =
    line.match(/(?:stt|#|số|so|mã|ma)\s*[:.]?\s*(\d{1,4}(?:\s*(?:-|–|đến|den|->|,|&|và|va|\/)\s*\d{1,4})*)/i) ||
    line.match(/^\s*(\d{1,4})\s*[.)\-:]\s+/);
  if (!m) return { stts: [], end: 0 };
  const stts = [];
  const parts = m[1].split(/\s*(?:,|&|và|va|\/)\s*/i);
  for (const p of parts) {
    const r = p.match(/^(\d{1,4})\s*(?:-|–|đến|den|->)\s*(\d{1,4})$/i);
    if (r) {
      const a = Number(r[1]), b = Number(r[2]);
      if (b > a && b - a <= 30) for (let i = a; i <= b; i++) stts.push(i);
      else stts.push(a, b);
    } else if (/^\d+$/.test(p)) stts.push(Number(p));
  }
  return { stts: [...new Set(stts)], end: m.index + m[0].length };
}

const tokenize = (s) => norm(s).replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((t) => t.length >= 2 && !/^\d+$/.test(t));
const STOP = new Set(["stt", "chi", "gia", "con", "dong", "combo", "sale", "deal", "nghin", "ngan", "tr", "trieu", "vnd", "san", "pham", "cho", "cac", "nhe", "nha", "a", "ạ"]);

/** Share of the comment's words found in the product name (null when the comment names nothing). */
export function nameScore(text, productName) {
  const words = tokenize(text).filter((w) => !STOP.has(w));
  if (words.length < 2) return null;
  const name = new Set(tokenize(productName));
  const hit = words.filter((w) => name.has(w)).length;
  return hit / words.length;
}

/**
 * @param {string} text pasted comments
 * @param {{id:number, stt:number, name:string, brand:string}[]} deals deals of one list
 * @returns {{matches: object[], unread: string[]}}
 */
export function parsePriceText(text, deals) {
  const bySTT = new Map(deals.map((d) => [d.stt, d]));
  const matches = [];
  const unread = [];
  const lines = String(text || "").replace(/\r/g, "").split(/\n|;|•/).map((l) => l.trim()).filter(Boolean).slice(0, 1000);
  for (const line of lines) {
    const { stts, end } = sttRefs(line);
    const prices = priceTokens(line).filter((t) => t.at >= end);
    const strong = prices.filter((t) => t.strong);
    const pick = strong.length ? strong[strong.length - 1] : prices[prices.length - 1];
    if (!stts.length || !pick) {
      if (/\d/.test(line) && line.length > 3) unread.push(line);
      continue;
    }
    const nameText = line.slice(end, pick.at);
    for (const stt of stts) {
      const d = bySTT.get(stt);
      if (!d) { matches.push({ line, stt, price: pick.v, dealId: null, status: "missing" }); continue; }
      const score = stts.length > 1 ? null : nameScore(nameText, d.brand + " " + d.name);
      let status = score === null || score >= 0.5 ? "ok" : "check";
      let suggestion = null;
      if (status === "check") {
        let best = null;
        for (const o of deals) {
          const s = nameScore(nameText, o.brand + " " + o.name);
          if (s !== null && (!best || s > best.score)) best = { id: o.id, stt: o.stt, name: o.name, score: s };
        }
        if (best && best.id !== d.id && best.score >= 0.6) suggestion = best;
      }
      matches.push({ line, stt, price: pick.v, dealId: d.id, name: d.name, brand: d.brand, score, status, suggestion, weak: !pick.strong });
    }
  }
  return { matches, unread };
}
