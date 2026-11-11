// Deal enrichment (categories, combo, gift) and the search/filter/facet engine used by the public API.
import { norm, terms } from "./text.js";

/** [label, regex, matchAgainstAccentedText?] — first two matches become the deal's categories */
export const CATEGORIES = [
  ["Tẩy trang", /\b(tay trang|micellar|cleansing (oil|balm|water)|makeup remover|remover)\b/],
  ["Rửa mặt", /\b(rua mat|cleanser|sua rua|gel rua|bot rua)\b/],
  ["Chống nắng", /\b(chong nang|spf|sunscreen|sun ?cream)\b/],
  ["Serum / tinh chất", /\b(serum|tinh chat|ampoule|essence|concentrate)\b/],
  ["Toner / nước dưỡng", /\b(toner|nuoc duong|nuoc hoa hong|nuoc sen|lotion)\b/],
  ["Kem dưỡng", /\b(kem duong|cream|duong am|thach|gel lam diu|moistur)\b/],
  ["Mặt nạ / pad", /\b(mat na|mask|pad)\b/],
  ["Trang điểm", /\b(son|phan|ma hong|ke mat|ke may|chi ke|mascara|cushion|che khuyet diem|kem lot|concealer|primer|lip|tint|setting spray|co dinh lop|eyeliner|liner|blush|highlight)\b/],
  ["Tóc", /\b(toc|dau goi|dau xa|da dau|shampoo|conditioner|u toc)\b/],
  ["Cơ thể", /\b(gel tam|sua tam|body|duong the|co the|lan khu mui|khu mui|tay da chet)\b/],
  ["Vệ sinh / răng miệng", /\b(dung dich ve sinh|ve sinh|ban chai|kem danh rang|nuoc suc mieng|bang ve sinh)\b/],
  ["Nước hoa", /\b(nuoc hoa|perfume|eau de|body mist)\b/],
  // accents matter here: "máy" (machine) vs "mây" (cloud, a lipstick name)
  ["Máy & thiết bị", /(^|[\s(\[-])(máy|nồi|chảo|bình giữ nhiệt|ấm siêu tốc|quạt|bàn là|bàn ủi|lọc nước|hút bụi|thiết bị|device|ipl)(?=$|[\s,.)\]-])/, true],
  ["Thực phẩm / bổ sung", /\b(vien uong|collagen|thuc pham|sua bot|ngu coc)\b/],
];
export const OTHER = "Khác";
export const CATEGORY_NAMES = [...CATEGORIES.map((c) => c[0]), OTHER];

const NO_GIFT = /^(x|-|–|không|khong|0|n\/a)$/i;

/** DB row → deal object with derived fields used for filtering. */
export function enrich(d) {
  const plain = norm(d.name);
  const accented = String(d.name).normalize("NFC").toLowerCase();
  const cats = CATEGORIES.filter(([, re, accent]) => re.test(accent ? accented : plain)).map((c) => c[0]).slice(0, 2);
  return {
    ...d,
    cats: cats.length ? cats : [OTHER],
    combo: /\bcombo\b|\bset\b|\bbo \d/.test(plain),
    giftHas: Boolean(d.gift && d.gift.trim() && !NO_GIFT.test(d.gift.trim())),
    _search: norm([d.brand, d.name, d.gift, d.note].join(" ")),
  };
}

/** pick: "best" | "live" | "v0" | "v1" … */
export function priceFor(d, pick = "best") {
  if (pick === "live") return d.live;
  if (/^v\d+$/.test(pick)) return d.voucher[Number(pick.slice(1))] ?? d.live;
  const all = [d.live, ...d.voucher].filter((x) => x != null);
  return all.length ? Math.min(...all) : null;
}

export function savingFor(d, pick) {
  const base = d.orig ?? d.live;
  const p = priceFor(d, pick);
  return base != null && p != null && base > p ? base - p : null;
}

function priceLabel(d, pick, labels) {
  if (pick === "live") return "Giá live";
  const p = priceFor(d, pick);
  if (/^v\d+$/.test(pick)) return d.voucher[Number(pick.slice(1))] != null ? labels[Number(pick.slice(1))] || "Voucher" : "Giá live";
  const i = d.voucher.findIndex((x) => x != null && x === p);
  return i >= 0 ? labels[i] || "Voucher" : "Giá live";
}

/**
 * @param {object[]} deals enriched deals (may span several lists)
 * @param {object} f filters: q, brands[], cats[], lists[], gift, priced, combo, min, max, pick, sort, offset, limit, ids[]
 * @param {(listId:number)=>string[]} labelsOf voucher labels per list
 */
export function searchDeals(deals, f, labelsOf) {
  const pick = f.pick || "best";
  const qTerms = terms(f.q || "");
  const brands = new Set(f.brands || []);
  const cats = new Set(f.cats || []);
  const lists = new Set((f.lists || []).map(Number));
  const ids = f.ids && f.ids.length ? new Set(f.ids.map(Number)) : null;

  const matches = (d, skip) => {
    if (ids && !ids.has(d.id)) return false;
    if (qTerms.length && !qTerms.every((t) => d._search.includes(t))) return false;
    if (skip !== "brands" && brands.size && !brands.has(d.brand)) return false;
    if (skip !== "cats" && cats.size && !d.cats.some((c) => cats.has(c))) return false;
    if (skip !== "lists" && lists.size && !lists.has(d.listId)) return false;
    if (f.gift && !d.giftHas) return false;
    if (f.needPrice && (d.live != null || d.voucher.some((v) => v != null))) return false;
    if (f.combo && !d.combo) return false;
    const p = priceFor(d, pick);
    if (f.priced && p == null) return false;
    if (f.min != null || f.max != null) {
      if (p == null) return false;
      if (f.min != null && p < f.min) return false;
      if (f.max != null && p > f.max) return false;
    }
    return true;
  };

  const hits = deals.filter((d) => matches(d));
  const P = (d) => priceFor(d, pick);
  const sorters = {
    // "Thứ tự trong deal list": the file's own row order (STT can repeat or jump in shop files)
    stt: (a, b) => a.listPosition - b.listPosition || a.id - b.id,
    save: (a, b) => (savingFor(b, pick) ?? -1) - (savingFor(a, pick) ?? -1),
    asc: (a, b) => (P(a) ?? Infinity) - (P(b) ?? Infinity),
    desc: (a, b) => (P(b) ?? -1) - (P(a) ?? -1),
    brand: (a, b) => a.brand.localeCompare(b.brand, "vi") || a.listPosition - b.listPosition || a.id - b.id,
  };
  hits.sort(sorters[f.sort] || sorters.stt);
  // Grouped by brand: brands in STT order (where each first appears in the deal list), and the
  // deals of a brand keep the chosen sort (by default STT). JS sort is stable.
  if (f.group) {
    const first = new Map();
    for (const d of hits.slice().sort(sorters.stt)) if (!first.has(d.brand)) first.set(d.brand, first.size);
    hits.sort((a, b) => first.get(a.brand) - first.get(b.brand));
  }

  // facet counts ignore their own filter, so picking one brand still shows the others
  const count = (skip, keyFn) => {
    const m = new Map();
    for (const d of deals) if (matches(d, skip)) for (const k of keyFn(d)) m.set(k, (m.get(k) || 0) + 1);
    return m;
  };
  const brandCounts = count("brands", (d) => [d.brand]);
  const allBrands = [...new Set(deals.map((d) => d.brand))];
  const catCounts = count("cats", (d) => d.cats);
  const listCounts = count("lists", (d) => [d.listId]);

  const priced = hits.filter((d) => P(d) != null);
  const topSave = priced.filter((d) => savingFor(d, pick)).sort((a, b) => savingFor(b, pick) - savingFor(a, pick))[0];
  const cheapest = priced.slice().sort((a, b) => P(a) - P(b))[0];
  const hitBrands = new Map();
  for (const d of hits) hitBrands.set(d.brand, (hitBrands.get(d.brand) || 0) + 1);
  const topBrand = [...hitBrands].sort((a, b) => b[1] - a[1])[0];

  const offset = Math.max(0, Number(f.offset) || 0);
  const limit = Math.min(500, Math.max(1, Number(f.limit) || 60));
  const view = (d) => publicDeal(d, pick, labelsOf(d.listId));

  return {
    total: hits.length,
    offset,
    items: hits.slice(offset, offset + limit).map(view),
    facets: {
      brands: allBrands
        .map((name) => ({ name, count: brandCounts.get(name) || 0 }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "vi")),
      categories: CATEGORY_NAMES.filter((c) => deals.some((d) => d.cats.includes(c))).map((name) => ({ name, count: catCounts.get(name) || 0 })),
      lists: [...listCounts].map(([id, count]) => ({ id, count })),
    },
    insights: {
      priced: priced.length,
      gifts: hits.filter((d) => d.giftHas).length,
      topSaving: topSave ? { deal: view(topSave), amount: savingFor(topSave, pick) } : null,
      cheapest: cheapest ? view(cheapest) : null,
      topBrand: topBrand ? { name: topBrand[0], count: topBrand[1] } : null,
    },
  };
}

// deals built without the report fields (tests, spreadsheets) only have `live`
const fileLiveOf = (d) => ("fileLive" in d ? d.fileLive : d.live);

export function publicDeal(d, pick = "best", labels = []) {
  return {
    id: d.id,
    listId: d.listId,
    stt: d.stt,
    page: d.page,
    brand: d.brand,
    name: d.name,
    gift: d.giftHas ? d.gift : "",
    note: d.note,
    cats: d.cats,
    combo: d.combo,
    live: d.live,
    liveRaw: d.liveRaw,
    // price from the file itself, or one announced later (admin / confirmed by viewers)
    fileLive: fileLiveOf(d),
    announced: d.announced || null,
    candidates: (d.candidates || []).map((c) => ({ price: c.price, votes: c.votes })),
    conflict: Boolean(d.conflict),
    canReport: Boolean(d.reportsOpen) && fileLiveOf(d) == null && d.announced?.source !== "admin",
    orig: d.orig,
    voucher: d.voucher,
    voucherRaw: d.voucherRaw,
    price: priceFor(d, pick),
    priceLabel: priceLabel(d, pick, labels),
    saving: savingFor(d, pick),
    // pictures cut out of the deal-list file (null when the row had none)
    image: d.images & 1 ? `/img/${d.listId}/${d.id}-p.webp` : null,
    giftImage: d.images & 2 && d.giftHas ? `/img/${d.listId}/${d.id}-g.webp` : null,
  };
}
