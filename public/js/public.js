// Public site: home (pinned deal lists) and the filterable deal view. Data comes from /api.
import { $, esc, fmt, parsePrice, store, api, toast, highlight } from "./util.js";

const HEART = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.8 4.5c2.1 0 3.6 1.1 5.2 3 1.6-1.9 3.1-3 5.2-3 3.8 0 5.9 3.9 4.4 7.3C19.5 16.4 12 21 12 21z"/></svg>';
const PAGE = 60;
// shown in the picture frame when a deal has no picture (yet)
const PHOTO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5.2-5.2a1 1 0 0 0-1.4 0L5 20"/></svg>';
const QUICK = [[0, 100000, "< 100k"], [100000, 300000, "100–300k"], [300000, 500000, "300–500k"], [500000, 1000000, "500k–1tr"], [1000000, null, "> 1tr"]];

const S = {
  lists: [],
  view: "home", // "home" | "all" | list id (number)
  q: "",
  pick: store.get("ssd.pick", "best"),
  sort: "stt",
  group: false,
  f: { brands: new Set(), cats: new Set(), lists: new Set(), gift: false, priced: false, needPrice: false, combo: false, wish: false, min: null, max: null },
  result: null,
  items: [],
  voucherLabels: [],
  wish: store.get("ssd.wish", {}), // id → {qty, deal snapshot}
  reqSeq: 0,
  loadingMore: false,
};

/* ---------- prices (client copy for the wishlist) ---------- */
function priceFor(d, pick = S.pick) {
  if (pick === "live") return d.live;
  if (/^v\d+$/.test(pick)) return d.voucher[Number(pick.slice(1))] ?? d.live;
  const all = [d.live, ...d.voucher].filter((x) => x != null);
  return all.length ? Math.min(...all) : null;
}
const pickLabel = () => (S.pick === "best" ? "Giá tốt nhất" : S.pick === "live" ? "Không voucher" : S.voucherLabels[Number(S.pick.slice(1))] || "Voucher");

/* ---------- routing ---------- */
function route() {
  const h = location.hash.slice(1);
  let next = "home";
  if (h === "all") next = "all";
  else if (/^list-\d+$/.test(h)) next = Number(h.slice(5));
  if (next !== S.view) {
    S.view = next;
    S.f.brands.clear(); S.f.cats.clear(); S.f.lists.clear();
  }
  render();
  window.scrollTo(0, 0);
}
function go(v) {
  const h = v === "home" ? "" : v === "all" ? "#all" : `#list-${v}`;
  if (location.hash === h || (!h && !location.hash)) return route();
  if (h) location.hash = h;
  else { history.pushState(null, "", location.pathname); route(); }
}

/* ---------- home ---------- */
function card(l) {
  const s = l.stats;
  return `<article class="card${l.pinned ? " pinned" : ""}">
    <div class="kicker"><span>${esc(l.session || "Deal list")}</span>${l.pinned ? '<span class="pinmark">Đang ghim</span>' : ""}</div>
    <h3>${esc(l.title)}</h3>
    <div class="stats">
      <div class="stat"><div class="v">${s.deals.toLocaleString("vi-VN")}</div><div class="k">deal</div></div>
      <div class="stat"><div class="v">${s.brands}</div><div class="k">brand</div></div>
      <div class="stat"><div class="v">${s.gifts}</div><div class="k">có quà</div></div>
    </div>
    ${s.topBrands.length ? `<div class="brands">${s.topBrands.map((b) => `<span>${esc(b)}</span>`).join("")}${s.brands > 6 ? `<span>+${s.brands - 6}</span>` : ""}</div>` : ""}
    <div class="go"><a class="btn primary" href="#list-${l.id}">Xem ${s.deals.toLocaleString("vi-VN")} deal</a>${s.priced ? `<span class="btn ghost small static">${s.priced} deal đã công bố giá</span>` : ""}</div>
  </article>`;
}
function renderHome() {
  const lists = S.lists.filter((l) => !l.draftPreview);
  const pinned = lists.filter((l) => l.pinned);
  const others = lists.filter((l) => !l.pinned);
  const total = lists.reduce((n, l) => n + l.stats.deals, 0);
  $("#view").innerHTML = `<div class="wrap home">
    <div class="intro"><h1>Deal livestream, lọc trong vài giây</h1>
      <p>Chọn một deal list rồi lọc theo brand, nhóm sản phẩm, mức giá sau voucher và quà tặng. Bấm ♡ để gom món muốn mua và cộng tổng tiền.</p></div>
    ${lists.length ? `
      ${pinned.length ? `<section class="sec"><h2>Deal list đang ghim</h2><div class="cards">${pinned.map(card).join("")}</div></section>` : ""}
      ${others.length ? `<section class="sec"><h2>Deal list khác</h2><div class="others">${others.map((l) => `<a href="#list-${l.id}"><span><strong>${esc(l.title)}</strong>${l.session ? ` <small>· ${esc(l.session)}</small>` : ""}</span><small class="num">${l.stats.deals} deal</small></a>`).join("")}</div></section>` : ""}
      ${lists.length > 1 ? `<section class="sec"><a class="btn" href="#all">Tìm trên tất cả ${lists.length} deal list (${total.toLocaleString("vi-VN")} deal)</a></section>` : ""}`
      : `<div class="emptyhome"><strong>Chưa có deal list nào.</strong><br>Deal list sẽ hiện ở đây khi quản trị viên đăng.</div>`}
  </div>`;
}

/* ---------- list view ---------- */
function currentList() { return typeof S.view === "number" ? S.lists.find((l) => l.id === S.view) : null; }

function renderListShell() {
  const one = currentList();
  const total = one ? one.stats.deals : S.lists.reduce((n, l) => n + l.stats.deals, 0);
  $("#view").innerHTML = `
    <div class="wrap listhead">
      <a class="back" href="#" data-go="home">← Tất cả deal list</a>
      <h1 class="full">${one ? esc(one.title) : typeof S.view === "number" ? "Deal list" : "Tất cả deal list"}</h1>
      <div class="meta">${total.toLocaleString("vi-VN")} deal${one?.session ? " · " + esc(one.session) : ""}</div>
      ${one?.reportsOpen && one.stats.hidden ? `<div class="helpbar"><span>Còn <strong class="num">${one.stats.hidden - one.stats.announced}</strong> deal chưa có giá. Thấy giá trong bình luận hay trên live? Dán vào đây để mọi người cùng xem.</span>
        <button class="btn primary small" type="button" id="pasteBtn">Dán giá từ bình luận</button>
        <button class="btn small" type="button" data-flagset="needPrice">Xem deal chưa có giá</button></div>` : ""}
    </div>
    <div class="wrap layout">
      <aside class="filters" id="fside" aria-label="Bộ lọc">
        <div class="fside-head"><h2>Bộ lọc</h2><button class="btn small" type="button" id="closeFilters">Đóng</button></div>
        <div id="filters" class="fstack">
          <div class="fgroup"><h3>Voucher bạn có</h3><div class="seg" id="vpick"></div></div>
          <div class="fgroup" ${S.view === "all" ? "" : "hidden"}><h3>Deal list <button type="button" data-clear="lists">Bỏ chọn</button></h3><div class="chips" id="listChips"></div></div>
          <div class="fgroup"><h3>Nhóm sản phẩm <button type="button" data-clear="cats">Bỏ chọn</button></h3><div class="chips" id="cats"></div></div>
          <div class="fgroup"><h3>Brand <button type="button" data-clear="brands">Bỏ chọn</button></h3>
            <input class="brandsearch" id="brandq" type="search" placeholder="Tìm brand…" aria-label="Tìm brand"><div class="brandlist" id="brands"></div></div>
          <div class="fgroup"><h3>Điều kiện</h3>
            <label class="toggle"><input type="checkbox" data-flag="gift" ${S.f.gift ? "checked" : ""}> Có quà tặng kèm</label>
            <label class="toggle"><input type="checkbox" data-flag="priced" ${S.f.priced ? "checked" : ""}> Đã có giá (bỏ "Giá hấp dẫn")</label>
            <label class="toggle"><input type="checkbox" data-flag="needPrice" ${S.f.needPrice ? "checked" : ""}> Chưa có giá (cần báo giá)</label>
            <label class="toggle"><input type="checkbox" data-flag="combo" ${S.f.combo ? "checked" : ""}> Chỉ combo</label>
            <label class="toggle"><input type="checkbox" data-flag="wish" ${S.f.wish ? "checked" : ""}> Chỉ món trong giỏ săn</label></div>
          <div class="fgroup"><h3>Giá cuối (đ) <button type="button" data-clear="price">Xoá</button></h3>
            <div class="range"><input id="pmin" inputmode="numeric" placeholder="Từ" aria-label="Giá từ"><span>–</span><input id="pmax" inputmode="numeric" placeholder="Đến" aria-label="Giá đến"></div>
            <div class="chips mt8" id="pquick"></div></div>
        </div>
        <div class="fside-foot"><button class="btn small" type="button" data-rm="all">Xoá bộ lọc</button>
          <button class="btn primary" type="button" id="applyFilters">Xem <span class="num" id="fN">…</span> deal</button></div>
      </aside>
      <main class="minw0">
        <div class="insights" id="insights"></div>
        <div class="resultbar"><button class="btn small fbtn" type="button" id="openFilters" aria-controls="fside" aria-expanded="false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>Bộ lọc <span class="count num" id="fCount" hidden></span></button><div class="n"><span class="num" id="nShown">…</span> deal</div>
          <label class="gswitch"><input type="checkbox" id="groupBrand" data-group role="switch" ${S.group ? "checked" : ""}><span class="track" aria-hidden="true"></span>Gom theo brand</label>
          <select id="sort" aria-label="Sắp xếp">
            <option value="stt">Thứ tự trong deal list</option><option value="save">Tiết kiệm nhiều nhất (đ)</option>
            <option value="asc">Giá cuối thấp → cao</option><option value="desc">Giá cuối cao → thấp</option><option value="brand">Brand A → Z</option>
          </select></div>
        <div class="active" id="active"></div>
        <div class="list" id="list"><div class="empty">Đang tải…</div></div>
        <div class="more" id="more" hidden><span class="subtle" id="shownOf" aria-live="polite"></span><button class="btn" type="button" id="moreBtn">Xem thêm</button></div>
      </main>
    </div>`;
  syncSort();
  syncPriceInputs();
}

/* While grouping by brand, the order is fixed (brands and deals in STT order): the sort menu is
   disabled and shows that order; the chosen sort comes back when grouping is turned off. */
function syncSort() {
  const sel = $("#sort");
  if (!sel) return;
  sel.disabled = S.group;
  sel.value = S.group ? "stt" : S.sort;
  sel.title = S.group ? "Đang gom theo brand: sắp theo STT. Tắt \"Gom theo brand\" để đổi cách sắp xếp." : "";
}

/* The header's height, for the result bar that sticks under it on phones (the header wraps). */
const topBar = document.querySelector(".top");
const setTopH = () => document.documentElement.style.setProperty("--toph", topBar.offsetHeight + "px");
setTopH();
if ("ResizeObserver" in window) new ResizeObserver(setTopH).observe(topBar);

/** After filters change while scrolled down the list, show the new results from their first deal. */
function backToListStart() {
  const bar = $(".resultbar");
  const first = $("#active")?.childElementCount ? $("#active") : $("#list");
  if (!bar || !first) return;
  const stuck = getComputedStyle(bar).position === "sticky" ? bar.offsetHeight : 0;
  const covered = topBar.offsetHeight + stuck + 8;
  const top = first.getBoundingClientRect().top;
  if (top < covered) window.scrollTo({ top: window.scrollY + top - covered, behavior: "instant" });
}

/* Phones/tablets: the filter column becomes a sidebar that slides in from the left. */
const mq = matchMedia("(max-width:860px)");
function filters(open) {
  const side = $("#fside");
  if (!side) return;
  if (open) { closeAll(); $("#scrim").hidden = false; }
  else if (!side.classList.contains("open")) return;
  side.classList.toggle("open", open);
  document.body.classList.toggle("noscroll", open);
  $("#openFilters")?.setAttribute("aria-expanded", String(open));
  if (open) $("#closeFilters").focus();
  else { $("#scrim").hidden = true; if (mq.matches) $("#openFilters")?.focus(); }
}
mq.addEventListener("change", () => { if (!mq.matches) filters(false); });

function params(offset = 0) {
  const p = new URLSearchParams();
  p.set("list", S.view === "all" ? "all" : String(S.view));
  if (S.q) p.set("q", S.q);
  if (S.f.brands.size) p.set("brands", [...S.f.brands].join(","));
  if (S.f.cats.size) p.set("cats", [...S.f.cats].join(","));
  if (S.f.lists.size) p.set("lists", [...S.f.lists].join(","));
  for (const k of ["gift", "priced", "needPrice", "combo"]) if (S.f[k]) p.set(k, "1");
  if (S.f.wish) p.set("ids", Object.keys(S.wish).join(",") || "0");
  if (S.f.min != null) p.set("min", S.f.min);
  if (S.f.max != null) p.set("max", S.f.max);
  if (S.group) p.set("group", "1");
  p.set("pick", S.pick);
  p.set("sort", S.group ? "stt" : S.sort);
  p.set("offset", offset);
  p.set("limit", PAGE);
  return p;
}

let loadTimer;
function load(delay = 0) {
  clearTimeout(loadTimer);
  loadTimer = setTimeout(async () => {
    const seq = ++S.reqSeq;
    try {
      const r = await api("/api/deals?" + params(0));
      if (seq !== S.reqSeq) return; // a newer request superseded this one
      S.result = r;
      S.items = r.items;
      S.voucherLabels = r.voucherLabels;
      renderResults();
      backToListStart();
    } catch (e) {
      if (seq !== S.reqSeq) return;
      if (e.status === 404) { toast("Deal list này không còn."); go("home"); return; }
      $("#list").innerHTML = `<div class="empty">Không tải được deal (${esc(e.message)}). Kiểm tra mạng rồi tải lại trang.</div>`;
    }
  }, delay);
}
/* Lazy loading: the next page loads by itself when the end of the list comes near the screen.
   The button stays as a fallback (no IntersectionObserver, or a failed request to retry). */
async function loadMore() {
  if (S.loadingMore || !S.result || S.items.length >= S.result.total) return;
  const seq = S.reqSeq;
  const btn = $("#moreBtn");
  S.loadingMore = true;
  if (btn) { btn.disabled = true; btn.textContent = "Đang tải thêm…"; }
  try {
    const r = await api("/api/deals?" + params(S.items.length));
    if (seq !== S.reqSeq) return; // filters changed meanwhile: that newer load owns the list
    const prevLast = S.items[S.items.length - 1];
    S.items = S.items.concat(r.items);
    appendRows(r.items, prevLast);
  } catch (e) {
    if (seq === S.reqSeq) toast("Không tải thêm được. Bấm \"Xem thêm\" để thử lại.");
  } finally {
    S.loadingMore = false;
    if (btn?.isConnected) btn.disabled = false;
    updateMore();
  }
}

let moreObserver = null;
function watchMore() {
  const more = $("#more");
  if (!more || !("IntersectionObserver" in window)) return;
  moreObserver?.disconnect();
  moreObserver = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) loadMore();
  }, { rootMargin: "800px 0px" });
  moreObserver.observe(more);
}

/** Rows for some deals; a brand header goes in front of each new brand when grouping. */
function rowsHtml(items, prevLast) {
  if (!S.group) return items.map(rowHtml).join("");
  const counts = new Map(S.result.facets.brands.map((b) => [b.name, b.count]));
  let last = prevLast?.brand ?? null;
  let html = "";
  for (const d of items) {
    if (d.brand !== last) { html += `<div class="row groupHead"><span>${esc(d.brand)}</span><span class="num">${counts.get(d.brand) ?? ""} deal</span></div>`; last = d.brand; }
    html += rowHtml(d);
  }
  return html;
}
function appendRows(items, prevLast) {
  if (items.length) $("#list").insertAdjacentHTML("beforeend", rowsHtml(items, prevLast));
}
function updateMore() {
  if (!$("#more")) return; // left the list view
  const r = S.result;
  const left = r ? r.total - S.items.length : 0;
  $("#more").hidden = left <= 0;
  $("#moreBtn").textContent = `Xem thêm (${left.toLocaleString("vi-VN")} deal nữa)`;
  $("#shownOf").textContent = r && left > 0 ? `Đang hiện ${S.items.length.toLocaleString("vi-VN")} / ${r.total.toLocaleString("vi-VN")} deal` : "";
  // a short page (or a tall screen) may already show the end: keep filling until it doesn't
  if (left > 0 && !S.loadingMore && "IntersectionObserver" in window) {
    requestAnimationFrame(() => {
      const box = $("#more")?.getBoundingClientRect();
      if (box && box.top < innerHeight + 800) loadMore();
    });
  }
}

/** Price announced after the list came out (admin or confirmed by viewers), or reports waiting for votes. */
function reportCell(d) {
  if (d.announced) {
    const who = d.announced.source === "admin" ? "Quản trị viên xác nhận" : `${d.announced.votes} người xác nhận`;
    return `<div class="lbl">Giá công bố</div><span class="tag">${fmt(d.announced.price)}</span>
      <div class="confirmed">${who}</div>
      ${d.canReport ? `<button class="linkbtn" type="button" data-report="${d.id}">${d.mine != null && d.mine !== d.announced.price ? `Bạn báo ${fmt(d.mine)}` : "Báo giá khác"}</button>` : ""}`;
  }
  const top = d.candidates[0];
  if (top) {
    const mineTop = d.mine === top.price;
    return `<div class="lbl">Người xem báo</div><span class="tag pending">${fmt(top.price)}</span>
      <div class="pendingnote">${top.votes} người · chưa xác nhận${d.candidates.length > 1 ? ` · có ${d.candidates.length - 1} giá khác` : ""}</div>
      ${d.mine != null && !mineTop ? `<div class="minetag">Bạn báo ${fmt(d.mine)}</div>` : ""}
      ${d.canReport ? `<div class="repbtns">${mineTop ? `<span class="minetag">Bạn đã báo</span>` : `<button class="btn small" type="button" data-confirm="${d.id}|${top.price}">Đúng giá</button>`}
        <button class="linkbtn" type="button" data-report="${d.id}">Giá khác</button></div>` : ""}`;
  }
  return `<span class="hidden-price">${esc(d.voucherRaw.find(Boolean) || d.liveRaw || "Chưa có giá")}<br>công bố trên live</span>
    ${d.canReport ? `<button class="btn small mt6" type="button" data-report="${d.id}">Báo giá</button>` : ""}`;
}

function rowHtml(d) {
  const p = d.price;
  const hasVoucher = d.voucher.some((x) => x != null);
  const late = d.fileLive == null; // price wasn't in the file
  const priceCell =
    late
      ? reportCell(d)
      : p != null && S.pick !== "live" && hasVoucher
        ? `<div class="lbl">${esc(d.priceLabel)}</div><span class="tag">${fmt(p)}</span>${d.saving ? `<div class="save">−${fmt(d.saving)}</div>` : ""}`
        : p != null
          ? `<div class="lbl">Giá</div><span class="tag">${fmt(p)}</span>`
          : `<span class="hidden-price">Chưa có giá</span>`;
  const listName = S.view === "all" ? S.lists.find((l) => l.id === d.listId)?.title : "";
  return `<div class="row">
    <button class="heart" type="button" data-wish="${d.id}" aria-pressed="${Boolean(S.wish[d.id])}" aria-label="Thêm vào giỏ săn">${HEART}</button>
    <div class="prod">
      ${d.image ? `<button class="thumb" type="button" data-zoom="${esc(d.image)}" data-cap="${esc(`STT ${d.stt} · ${d.brand} · ${d.name}`)}" aria-label="Xem ảnh sản phẩm"><img src="${esc(d.image)}" alt="" loading="lazy" decoding="async"></button>`
        : `<span class="thumb ph" title="Chưa có ảnh" aria-hidden="true">${PHOTO}</span>`}
      <div class="ptext">
      <div class="b"><span class="stt num" title="STT trong deal list gốc">STT ${d.stt}</span><button type="button" data-brand="${esc(d.brand)}" title="Lọc theo brand này">${highlight(d.brand, S.q)}</button></div>
      <div class="nm">${highlight(d.name, S.q)}</div>
      <div class="meta">${d.combo ? '<span class="pill combo">Combo</span>' : ""}${d.cats.map((c) => `<span class="pill">${esc(c)}</span>`).join("")}
        ${d.gift ? `<span class="pill gift">Quà</span>${d.giftImage ? `<button class="thumb small" type="button" data-zoom="${esc(d.giftImage)}" data-cap="${esc(`Quà tặng: ${d.gift}`)}" aria-label="Xem ảnh quà tặng"><img src="${esc(d.giftImage)}" alt="" loading="lazy" decoding="async"></button>` : ""}<span class="gifttext">${highlight(d.gift, S.q)}</span>` : ""}
        ${d.page || listName ? `<span>${d.page ? `trang ${d.page}` : ""}${d.page && listName ? " · " : ""}${listName ? esc(listName) : ""}</span>` : ""}</div>
      </div>
    </div>
    <div class="price l"><div class="lbl">Giá live</div><div class="live ${!late && p != null && d.live != null && p < d.live ? "struck" : ""}">${d.fileLive != null ? fmt(d.fileLive) : esc(d.liveRaw || "—")}</div></div>
    <div class="price v">${priceCell}</div>
  </div>`;
}

function renderList() {
  $("#list").innerHTML = rowsHtml(S.items) || `<div class="empty">Không có deal nào khớp bộ lọc. Thử bỏ bớt điều kiện hoặc tìm từ khoá ngắn hơn.</div>`;
  updateMore();
  watchMore();
}

function renderResults() {
  const r = S.result;
  $("#nShown").textContent = r.total.toLocaleString("vi-VN");
  $("#fN").textContent = r.total.toLocaleString("vi-VN");
  const opts = [["best", "Tốt nhất"], ...S.voucherLabels.map((l, i) => ["v" + i, l.replace("Voucher ", "Mã ")]), ["live", "Không có mã"]];
  $("#vpick").innerHTML = opts.map(([k, l]) => `<button type="button" data-pick="${k}" aria-pressed="${S.pick === k}">${esc(l)}</button>`).join("");
  if (S.view === "all") {
    const lc = new Map(r.facets.lists.map((x) => [x.id, x.count]));
    $("#listChips").innerHTML = S.lists.map((l) => `<button class="chip" type="button" data-listf="${l.id}" aria-pressed="${S.f.lists.has(String(l.id))}">${esc(l.title)} <small>${lc.get(l.id) || 0}</small></button>`).join("");
  }
  $("#cats").innerHTML = r.facets.categories.map((c) => `<button class="chip" type="button" data-cat="${esc(c.name)}" aria-pressed="${S.f.cats.has(c.name)}">${esc(c.name)} <small>${c.count}</small></button>`).join("");
  renderBrands();
  $("#pquick").innerHTML = QUICK.map(([a, b, l]) => `<button class="chip" type="button" data-pq="${a}|${b ?? ""}" aria-pressed="${S.f.min === (a || null) && S.f.max === b}">${l}</button>`).join("");
  renderActive();
  renderInsights();
  renderList();
  renderWish();
}

function renderBrands() {
  if (!S.result) return;
  const bq = $("#brandq").value.trim().toLowerCase();
  const list = S.result.facets.brands
    .filter((b) => !bq || b.name.toLowerCase().includes(bq) || b.name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().includes(bq))
    .sort((a, b) => S.f.brands.has(b.name) - S.f.brands.has(a.name));
  $("#brands").innerHTML = list.length
    ? list.map((b) => `<label><input type="checkbox" data-b="${esc(b.name)}" ${S.f.brands.has(b.name) ? "checked" : ""}><span>${esc(b.name)}</span><small>${b.count}</small></label>`).join("")
    : `<div class="emptysmall">Không có brand khớp</div>`;
}

function renderActive() {
  const f = S.f, a = [];
  if (S.q) a.push(["q", `"${S.q}"`]);
  f.brands.forEach((b) => a.push(["brand:" + b, b]));
  f.cats.forEach((c) => a.push(["cat:" + c, c]));
  f.lists.forEach((id) => a.push(["list:" + id, S.lists.find((l) => String(l.id) === id)?.title || id]));
  if (f.gift) a.push(["gift", "Có quà"]);
  if (f.priced) a.push(["priced", "Đã có giá"]);
  if (f.needPrice) a.push(["needPrice", "Chưa có giá"]);
  if (f.combo) a.push(["combo", "Combo"]);
  if (f.wish) a.push(["wish", "Trong giỏ"]);
  if (f.min != null || f.max != null) a.push(["price", `${f.min != null ? fmt(f.min) : "0"} – ${f.max != null ? fmt(f.max) : "∞"} đ`]);
  const n = a.filter(([k]) => k !== "q").length;
  $("#fCount").hidden = !n;
  $("#fCount").textContent = n;
  $("#active").innerHTML = a.length
    ? a.map(([k, l]) => `<span class="chip">${esc(l)}<button type="button" data-rm="${esc(k)}" aria-label="Bỏ lọc ${esc(l)}">×</button></span>`).join("") + `<button class="chip" type="button" data-rm="all">Xoá tất cả</button>`
    : "";
}

function renderInsights() {
  const i = S.result.insights;
  const box = (k, v) => `<div class="insight"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  $("#insights").innerHTML = [
    box("Đã công bố giá", `<span class="num">${i.priced}</span> / <span class="num">${S.result.total}</span> deal`),
    box("Tiết kiệm nhiều nhất", i.topSaving ? `<button type="button" data-jump="${esc(i.topSaving.deal.name.slice(0, 60))}">−${fmt(i.topSaving.amount)}đ · ${esc(i.topSaving.deal.brand)}</button>` : "—"),
    box("Rẻ nhất", i.cheapest ? `<button type="button" data-jump="${esc(i.cheapest.name.slice(0, 60))}">${fmt(i.cheapest.price)}đ · ${esc(i.cheapest.name.slice(0, 40))}</button>` : "—"),
    box("Brand nhiều deal nhất", i.topBrand ? `<button type="button" data-brand="${esc(i.topBrand.name)}">${esc(i.topBrand.name)} (${i.topBrand.count})</button>` : "—"),
    box("Có quà tặng kèm", i.gifts ? `<button type="button" data-flagset="gift"><span class="num">${i.gifts}</span> deal</button>` : "0 deal"),
  ].join("");
}

function syncPriceInputs() {
  const a = $("#pmin"), b = $("#pmax");
  if (a) a.value = S.f.min != null ? fmt(S.f.min) : "";
  if (b) b.value = S.f.max != null ? fmt(S.f.max) : "";
}

function render() {
  if (S.view === "home") renderHome();
  else { renderListShell(); load(); }
  const sess = (S.lists.find((l) => l.pinned) || S.lists[0] || {}).session || "";
  const m = sess.match(/\d{1,2}[/.]\d{1,2}/);
  $("#eventLabel").textContent = m ? m[0].replace("/", ".") : "";
  renderWish();
}

/* ---------- wishlist (kept in this browser) ---------- */
function snapshot(d) {
  return { id: d.id, listId: d.listId, brand: d.brand, name: d.name, gift: d.gift, live: d.live, liveRaw: d.liveRaw, voucher: d.voucher, image: d.image || null };
}
function renderWish() {
  const w = Object.values(S.wish);
  const n = w.reduce((s, x) => s + x.qty, 0);
  $("#wishCount").textContent = n;
  $("#wishCount2").textContent = n ? `(${n})` : "";
  $("#pickLbl").textContent = "· " + pickLabel();
  let total = 0, unknown = 0;
  $("#wishList").innerHTML = w.length
    ? w.map(({ d, qty }) => {
        const p = priceFor(d);
        if (p != null) total += p * qty; else unknown++;
        return `<div class="witem">${d.image ? `<img class="wthumb" src="${esc(d.image)}" alt="" loading="lazy">` : `<span class="wthumb ph" aria-hidden="true">${PHOTO}</span>`}<div class="minw0"><div class="b">${esc(d.brand)}</div><div>${esc(d.name)}</div>
          <div class="num subtle">${p != null ? fmt(p) + "đ" : "Giá công bố trên live"}${d.gift ? " · có quà" : ""}</div></div>
          <input type="number" min="1" value="${qty}" data-qty="${d.id}" aria-label="Số lượng"><button class="x" type="button" data-unwish="${d.id}" aria-label="Bỏ khỏi giỏ">×</button></div>`;
      }).join("")
    : `<div class="empty">Bấm ♡ ở deal bạn muốn mua để gom vào đây, cộng tổng tiền và so với ngân sách.</div>`;
  $("#wishTotal").textContent = fmt(total) + "đ" + (unknown ? ` + ${unknown} món chưa có giá` : "");
  const b = parsePrice($("#budget").value);
  $("#budgetLine").hidden = b == null;
  if (b != null) {
    const left = b - total;
    $("#budgetLeft").innerHTML = `<span class="${left < 0 ? "over" : "under"}">${left < 0 ? "Vượt " : ""}${fmt(Math.abs(left))}đ</span>`;
  }
  store.set("ssd.wish", S.wish);
}
function wishText(tsv) {
  const w = Object.values(S.wish);
  if (tsv) {
    return ["Brand\tSản phẩm\tSL\tGiá live\t" + pickLabel() + "\tQuà tặng",
      ...w.map(({ d, qty }) => [d.brand, d.name, qty, d.live ?? d.liveRaw, priceFor(d) ?? "", d.gift].join("\t"))].join("\n");
  }
  let t = 0;
  const lines = w.map(({ d, qty }, i) => {
    const p = priceFor(d);
    if (p != null) t += p * qty;
    return `${i + 1}. [${d.brand}] ${d.name}${qty > 1 ? " x" + qty : ""} — ${p != null ? fmt(p) + "đ" : "giá trên live"}${d.gift ? " (quà: " + d.gift + ")" : ""}`;
  });
  return `Giỏ săn deal (${pickLabel()}):\n${lines.join("\n")}\nTổng: ${fmt(t)}đ`;
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Đã sao chép"); }
  catch { const a = $("#copyArea"); a.hidden = false; a.value = text; a.focus(); a.select(); toast("Đã chọn sẵn nội dung, nhấn Ctrl+C để sao chép"); }
}
/** Enlarged product / gift picture. */
function zoom(src, cap) {
  closeAll();
  $("#zoomImg").src = src;
  $("#zoomCap").textContent = cap || "";
  $("#zoomBox").hidden = false;
  $("#zoomClose").focus();
}
function closeAll() {
  for (const id of ["#drawer", "#pasteDrawer", "#reportBox", "#zoomBox"]) $(id).hidden = true;
  $("#scrim").hidden = true;
  const side = $("#fside");
  if (side?.classList.contains("open")) {
    side.classList.remove("open");
    document.body.classList.remove("noscroll");
    $("#openFilters")?.setAttribute("aria-expanded", "false");
  }
}
function drawer(open) { closeAll(); $("#drawer").hidden = !open; $("#scrim").hidden = !open; if (open) renderWish(); }

/* ---------- price reports ---------- */
let reporting = null;
function openReport(id) {
  const d = S.items.find((x) => String(x.id) === String(id));
  if (!d) return;
  reporting = d;
  closeAll();
  $("#repName").textContent = `#${d.stt} · ${d.brand} · ${d.name}`;
  $("#repPrice").value = d.mine != null ? fmt(d.mine) : "";
  $("#repErr").textContent = "";
  $("#reportBox").hidden = false;
  $("#repPrice").focus();
}
function replaceItem(deal) {
  const i = S.items.findIndex((x) => x.id === deal.id);
  if (i >= 0) S.items[i] = { ...S.items[i], ...deal, price: deal.live, priceLabel: "Giá công bố" };
  renderList();
}
async function sendReport(dealId, price, source) {
  try {
    const r = await api("/api/reports", { method: "POST", body: JSON.stringify({ dealId, price, source }) });
    replaceItem(r.deal);
    toast(r.deal.announced?.price === price ? "Cảm ơn! Giá đã được xác nhận cho mọi người." : "Cảm ơn! Giá sẽ hiện cho mọi người khi có thêm một người xác nhận.", 3500);
    return true;
  } catch (e) {
    toast(e.message, 3500);
    return false;
  }
}
$("#reportForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const price = parsePrice($("#repPrice").value) ?? (/^\s*\d{1,4}\s*$/.test($("#repPrice").value) ? Number($("#repPrice").value) * 1000 : null);
  if (!price || price < 1000) { $("#repErr").textContent = "Nhập giá dạng 215k, 215.000 hoặc 1tr2."; return; }
  if (await sendReport(reporting.id, price, $("#repSource").value)) closeAll();
});

/* paste a comment → read prices → choose → send */
let pasted = [];
function openPaste() { closeAll(); $("#pasteDrawer").hidden = false; $("#scrim").hidden = false; $("#pasteText").focus(); }
async function readPaste() {
  const text = $("#pasteText").value.trim();
  if (!text) { $("#pasteStatus").textContent = "Dán nội dung bình luận trước."; return; }
  $("#pasteStatus").textContent = "Đang đọc…";
  try {
    const r = await api(`/api/lists/${S.view}/price-text`, { method: "POST", body: JSON.stringify({ text }) });
    pasted = r.matches.map((m) => ({ ...m, on: m.status === "ok" && m.canReport }));
    const usable = pasted.filter((m) => m.canReport).length;
    $("#pasteStatus").textContent = pasted.length ? `Đọc được ${pasted.length} giá, ${usable} deal có thể báo.` : "Không đọc được giá nào. Mỗi dòng cần có STT và giá.";
    renderPaste(r.unread);
  } catch (e) {
    $("#pasteStatus").textContent = e.message;
  }
}
function renderPaste(unread = []) {
  const why = (m) =>
    m.status === "missing" ? "Không có STT này trong deal list"
    : !m.canReport ? (m.current?.fileLive != null ? `Đã có giá ${fmt(m.current.fileLive)}` : m.current?.announced?.source === "admin" ? `Đã xác nhận ${fmt(m.current.announced.price)}` : "Không báo được")
    : m.status === "check" ? `Tên không khớp STT ${m.stt}${m.suggestion ? ` (giống #${m.suggestion.stt} hơn${m.suggestion.canReport ? "" : ", deal đó đã có giá"})` : ""}` : "";
  $("#pasteResult").innerHTML = pasted.length || unread.length ? `
    <div class="tablewrap mt8"><table class="preview">
      <thead><tr><th></th><th>STT</th><th>Sản phẩm trong deal list</th><th>Giá đọc được</th><th>Ghi chú</th></tr></thead>
      <tbody>${pasted.map((m, i) => `<tr class="m-${m.status}">
        <td><input type="checkbox" data-pidx="${i}" ${m.on ? "checked" : ""} ${m.canReport ? "" : "disabled"} aria-label="Chọn STT ${m.stt}"></td>
        <td class="num">${m.stt}</td><td>${m.name ? esc(m.name) : "—"}<div class="subtle">${esc(m.line)}</div></td>
        <td class="num">${fmt(m.price)}${m.weak ? " ?" : ""}</td>
        <td>${esc(why(m))}${m.suggestion?.canReport ? ` <button class="linkbtn" type="button" data-usesugg="${i}">Dùng #${m.suggestion.stt}</button>` : ""}</td></tr>`).join("")}</tbody>
    </table></div>
    ${unread.length ? `<details class="mt8"><summary>${unread.length} dòng không đọc được</summary><ul class="unread">${unread.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></details>` : ""}` : "";
  const n = pasted.filter((m) => m.on).length;
  $("#pasteSend").disabled = !n;
  $("#pasteSend").textContent = n ? `Gửi ${n} giá đã chọn` : "Gửi giá đã chọn";
}
async function sendPaste() {
  const items = pasted.filter((m) => m.on).map((m) => ({ dealId: m.dealId, price: m.price }));
  if (!items.length) return;
  $("#pasteSend").disabled = true;
  try {
    const r = await api("/api/reports/bulk", { method: "POST", body: JSON.stringify({ items, source: "Bình luận" }) });
    const failed = r.results.filter((x) => !x.ok);
    toast(`Cảm ơn! Đã gửi ${r.saved} giá.${failed.length ? ` ${failed.length} giá không gửi được: ${failed[0].error}` : ""} Giá hiện cho mọi người khi có người khác xác nhận.`, 5000);
    closeAll();
    $("#pasteText").value = "";
    pasted = [];
    renderPaste();
    load();
  } catch (e) {
    toast(e.message, 4000);
    $("#pasteSend").disabled = false;
  }
}
document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.id === "pasteBtn") openPaste();
  else if (t.id === "pasteRead") readPaste();
  else if (t.id === "pasteSend") sendPaste();
  else if (t.dataset.closeall != null) closeAll();
  else if (t.dataset.report) openReport(t.dataset.report);
  else if (t.dataset.confirm) { const [id, p] = t.dataset.confirm.split("|").map(Number); t.disabled = true; sendReport(id, p, "Xác nhận"); }
  else if (t.dataset.usesugg) {
    const m = pasted[Number(t.dataset.usesugg)];
    Object.assign(m, { dealId: m.suggestion.id, stt: m.suggestion.stt, name: m.suggestion.name, status: "ok", on: true, canReport: true, suggestion: null });
    renderPaste();
  }
});
document.addEventListener("change", (e) => {
  if (e.target.dataset?.pidx != null) {
    pasted[Number(e.target.dataset.pidx)].on = e.target.checked;
    renderPaste();
  }
});

/* ---------- events ---------- */
const refilter = () => { if (S.view !== "home") load(); };
document.addEventListener("click", (e) => {
  const t = e.target.closest("button, a[data-go]");
  if (!t) return;
  const d = t.dataset;
  if (d.go) { e.preventDefault(); go(d.go); return; }
  if (d.wish) {
    const deal = S.items.find((x) => String(x.id) === d.wish);
    if (S.wish[d.wish]) delete S.wish[d.wish];
    else if (deal) S.wish[d.wish] = { d: snapshot(deal), qty: 1 };
    t.setAttribute("aria-pressed", Boolean(S.wish[d.wish]));
    renderWish();
    return;
  }
  if (d.unwish) { delete S.wish[d.unwish]; renderWish(); if (S.view !== "home") renderList(); return; }
  if (d.brand) { if (S.view === "home") return; S.f.brands = new Set([d.brand]); refilter(); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
  if (d.cat) { S.f.cats.has(d.cat) ? S.f.cats.delete(d.cat) : S.f.cats.add(d.cat); refilter(); return; }
  if (d.listf) { S.f.lists.has(d.listf) ? S.f.lists.delete(d.listf) : S.f.lists.add(d.listf); refilter(); return; }
  if (d.pick) { S.pick = d.pick; store.set("ssd.pick", S.pick); refilter(); return; }
  if (d.flagset) { S.f[d.flagset] = true; const cb = document.querySelector(`[data-flag="${d.flagset}"]`); if (cb) cb.checked = true; refilter(); return; }
  if (d.jump != null) { S.q = d.jump; $("#q").value = S.q; refilter(); return; }
  if (d.pq) {
    const [a, b] = d.pq.split("|");
    const mn = Number(a) || null, mx = b ? Number(b) : null;
    if (S.f.min === mn && S.f.max === mx) S.f.min = S.f.max = null; else { S.f.min = mn; S.f.max = mx; }
    syncPriceInputs(); refilter(); return;
  }
  if (d.clear) {
    if (d.clear === "price") { S.f.min = S.f.max = null; syncPriceInputs(); } else S.f[d.clear].clear();
    refilter(); return;
  }
  if (d.rm) {
    const k = d.rm, f = S.f;
    if (k === "all") {
      S.q = ""; $("#q").value = "";
      f.brands.clear(); f.cats.clear(); f.lists.clear();
      // every on/off filter (Có quà, Đã có giá, Chưa có giá, Combo, Trong giỏ…), not a hand-kept list
      for (const k of Object.keys(f)) if (typeof f[k] === "boolean") f[k] = false;
      f.min = f.max = null;
      document.querySelectorAll("[data-flag]").forEach((c) => (c.checked = false));
      syncPriceInputs();
    } else if (k === "q") { S.q = ""; $("#q").value = ""; }
    else if (k.startsWith("brand:")) f.brands.delete(k.slice(6));
    else if (k.startsWith("cat:")) f.cats.delete(k.slice(4));
    else if (k.startsWith("list:")) f.lists.delete(k.slice(5));
    else if (k === "price") { f.min = f.max = null; syncPriceInputs(); }
    else { f[k] = false; const cb = document.querySelector(`[data-flag="${k}"]`); if (cb) cb.checked = false; }
    refilter(); return;
  }
  if (t.id === "moreBtn") { loadMore(); return; }
  if (t.id === "openFilters") { filters(true); return; }
  if (t.dataset.zoom) { zoom(t.dataset.zoom, t.dataset.cap); return; }
  if (t.id === "zoomClose") { closeAll(); return; }
  if (t.id === "closeFilters" || t.id === "applyFilters") { filters(false); return; }
});
document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.b != null) { t.checked ? S.f.brands.add(t.dataset.b) : S.f.brands.delete(t.dataset.b); refilter(); return; }
  if (t.dataset.flag) { S.f[t.dataset.flag] = t.checked; refilter(); return; }
  if (t.dataset.qty) { const w = S.wish[t.dataset.qty]; if (w) w.qty = Math.max(1, Number(t.value) || 1); renderWish(); return; }
  if (t.id === "pmin" || t.id === "pmax") { S.f[t.id === "pmin" ? "min" : "max"] = parsePrice(t.value); syncPriceInputs(); refilter(); return; }
  if (t.id === "sort") { S.sort = t.value; refilter(); return; }
  if (t.dataset.group != null) {
    S.group = t.checked;
    document.querySelectorAll("[data-group]").forEach((x) => { x.checked = S.group; });
    syncSort();
    refilter();
    return;
  }
});
document.addEventListener("input", (e) => { if (e.target.id === "brandq") renderBrands(); });
$("#q").addEventListener("input", (e) => {
  S.q = e.target.value.trim();
  if (S.view === "home") { if (S.q && S.lists.length) go(S.lists.length === 1 ? S.lists[0].id : "all"); return; }
  load(200);
});
$("#wishBtn").addEventListener("click", () => drawer(true));
$("#closeDrawer").addEventListener("click", () => drawer(false));
$("#scrim").addEventListener("click", () => drawer(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if ($("#fside")?.classList.contains("open")) filters(false); else { drawer(false); closeAll(); } }
  if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $("#q").focus(); }
});
$("#budget").value = store.get("ssd.budget", "");
$("#budget").addEventListener("input", () => { store.set("ssd.budget", $("#budget").value); renderWish(); });
$("#copyWish").addEventListener("click", () => copy(wishText(false)));
$("#copyTsv").addEventListener("click", () => copy(wishText(true)));
$("#fitBudget").addEventListener("click", () => {
  const b = parsePrice($("#budget").value);
  if (b == null) { toast("Nhập ngân sách trước"); $("#budget").focus(); return; }
  if (S.view === "home") { toast("Mở một deal list trước"); return; }
  const used = Object.values(S.wish).reduce((s, { d, qty }) => s + (priceFor(d) || 0) * qty, 0);
  const left = b - used;
  if (left <= 0) { toast("Giỏ đã dùng hết ngân sách"); return; }
  S.f.min = null; S.f.max = left; S.sort = "save";
  // the suggestion is a ranking by saving, so it ends grouping by brand
  S.group = false;
  document.querySelectorAll("[data-group]").forEach((x) => { x.checked = false; });
  drawer(false); syncSort(); syncPriceInputs(); load();
  toast(`Đang hiện deal ≤ ${fmt(left)}đ, xếp theo tiết kiệm nhiều nhất`);
});
window.addEventListener("hashchange", route);

/* ---------- start ---------- */
(async () => {
  try {
    S.lists = (await api("/api/lists")).lists;
  } catch (e) {
    $("#view").innerHTML = `<div class="wrap home"><div class="emptyhome">Không tải được deal list (${esc(e.message)}). Tải lại trang để thử lại.</div></div>`;
    return;
  }
  // an admin previewing a draft list opens it by id even though it is not in the public list
  const h = location.hash.match(/^#list-(\d+)$/);
  if (h && !S.lists.some((l) => l.id === Number(h[1]))) {
    try { const { list } = await api(`/api/lists/${h[1]}`); S.lists.push({ ...list, draftPreview: true }); } catch { /* not visible: route() falls back */ }
  }
  route();
})();
// tap outside the enlarged picture to close it
$("#zoomBox").addEventListener("click", (e) => { if (e.target.id === "zoomBox") closeAll(); });
