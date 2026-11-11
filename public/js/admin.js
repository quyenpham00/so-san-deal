// Admin page: log in, import deal-list files, publish / pin / reorder / rename / delete lists.
import { $, esc, api, toast } from "./util.js";

const ICON = {
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M12 19V5m0 0-6 6m6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M12 5v14m0 0 6-6m-6 6-6-6"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
};
const A = { lists: [], last: null, busy: false };

async function start() {
  let me;
  try { me = await api("/api/admin/me"); }
  catch (e) { $("#app").innerHTML = `<p class="err pad24">Không kết nối được máy chủ: ${esc(e.message)}</p>`; return; }
  if (!me.enabled) {
    $("#app").innerHTML = `<div class="login panel"><h1>Chưa bật trang quản trị</h1><p>Đặt <code>ADMIN_PASSWORD</code> trong file <code>.env</code> rồi khởi động lại máy chủ.</p></div>`;
    return;
  }
  if (!me.admin) return renderLogin();
  $("#logoutBtn").hidden = false;
  await refresh();
}

function renderLogin(error = "") {
  $("#app").innerHTML = `<form class="login panel" id="loginForm">
    <h1>Đăng nhập quản trị</h1>
    <label for="pw">Mật khẩu</label>
    <input id="pw" type="password" autocomplete="current-password" required autofocus>
    <div class="err" id="loginErr">${esc(error)}</div>
    <button class="btn primary" type="submit">Đăng nhập</button>
  </form>`;
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password: $("#pw").value }) });
      $("#logoutBtn").hidden = false;
      await refresh();
    } catch (err) {
      $("#loginErr").textContent = err.message;
    }
  });
}

async function refresh() {
  try {
    A.lists = (await api("/api/admin/lists")).lists;
  } catch (e) {
    if (e.status === 401) return renderLogin("Phiên đăng nhập đã hết. Đăng nhập lại.");
    toast(e.message);
    return;
  }
  render();
}

function render() {
  queueMicrotask(watchImages);
  $("#app").innerHTML = `<div class="adm">
    <h1>Deal list</h1>
    <section class="panel">
      <h2>Nhập deal list mới</h2>
      <div class="drop" id="drop">Kéo thả file vào đây: <strong>PDF</strong> (bảng STT · BRAND · Tên sản phẩm · Giá livestream · Giá sau voucher · Quà tặng) hoặc <strong>Excel / CSV</strong> cùng tên cột.<br>
        <button class="btn primary small mt10" type="button" id="pickFile">Chọn file</button>
        <input type="file" id="file" accept=".pdf,.xlsx,.xls,.csv" multiple hidden>
        <div class="status" id="status" aria-live="polite"></div>
      </div>
      <form class="linkrow" id="linkForm">
        <label for="driveUrl">Hoặc dán link Google Drive / Google Sheets (file hoặc thư mục, chia sẻ "Bất kỳ ai có đường liên kết")</label>
        <div class="linkinput"><input id="driveUrl" type="url" inputmode="url" placeholder="https://drive.google.com/file/d/…" autocomplete="off" required>
          <button class="btn primary small" type="submit" id="linkBtn">Nhập từ link</button></div>
        <div id="folderPick"></div>
      </form>
      <div id="result"></div>
    </section>
    <section class="panel">
      <h2>Tất cả deal list (${A.lists.length}) · thứ tự trên trang chủ</h2>
      ${A.lists.length ? `<div class="alist">${A.lists.map(itemHtml).join("")}</div>`
        : `<div class="adminnote">Chưa có deal list. Nhập file ở trên để bắt đầu.</div>`}
      <p class="adminnote mt12">Trang chủ hiện các deal list <strong>Đã đăng</strong> có <strong>Ghim</strong> trước, theo thứ tự này. Deal list ở trạng thái <strong>Nháp</strong> chỉ quản trị viên xem được. <strong>Báo giá</strong>: cho người xem báo giá các deal "Giá hấp dẫn".</p>
    </section>
    ${A.lists.length ? `<section class="panel" id="reviewPanel">
      <h2>Giá các deal "Giá hấp dẫn"</h2>
      <div class="btnrow"><label for="revList" class="nowrap13">Deal list</label>
        <select id="revList">${A.lists.map((l) => `<option value="${l.id}" ${l.id === A.reviewId ? "selected" : ""}>${esc(l.title)}</option>`).join("")}</select></div>
      <details class="mt12"><summary><strong>Dán bình luận để đặt giá chính thức</strong></summary>
        <textarea id="offText" class="pastearea mt8" placeholder="STT 30 Combo 2 Nước tẩy trang tảo biển chỉ 215k"></textarea>
        <div class="btnrow mt8"><button class="btn small" type="button" id="offRead">Đọc giá</button><span class="status" id="offStatus"></span></div>
        <div id="offResult"></div>
      </details>
      <div id="revBody" class="mt12"></div>
    </section>` : ""}
  </div>`;
  renderResult();
  if (A.lists.length) loadReview(A.reviewId && A.lists.some((l) => l.id === A.reviewId) ? A.reviewId : A.lists[0].id);
}

/* ---------- price review ---------- */
async function loadReview(id) {
  A.reviewId = Number(id);
  try {
    A.review = await api(`/api/admin/lists/${id}/reviews`);
  } catch (e) {
    $("#revBody").innerHTML = `<p class="err">${esc(e.message)}</p>`;
    return;
  }
  renderReview();
}
function renderReview() {
  const r = A.review;
  const conflicts = r.items.filter((i) => i.announced?.source !== "admin" && i.candidates.length > 1).length;
  const waiting = r.items.filter((i) => !i.announced && i.candidates.length).length;
  const row = (i) => {
    const state = i.announced?.source === "admin" ? `<span class="state pub">Chính thức</span>`
      : i.announced ? `<span class="state pub">Người xem xác nhận</span>`
      : i.candidates.length > 1 ? `<span class="state warnstate">Nhiều giá khác nhau</span>` : `<span class="state draft">Chờ xác nhận</span>`;
    return `<tr>
      <td class="num">${i.stt}</td>
      <td>${esc(i.brand)} · ${esc(i.name)}<div class="mt6">${state}</div></td>
      <td>${i.candidates.length ? i.candidates.map((c) => `<div class="cand"><span class="num"><strong>${c.price.toLocaleString("vi-VN")}</strong> · ${c.votes} người</span>
          <button class="linkbtn" type="button" data-approve="${i.id}|${c.price}">Duyệt</button>
          <button class="linkbtn" type="button" data-reject="${i.id}|${c.price}">Từ chối</button>
          <button class="linkbtn" type="button" data-block="${i.id}|${c.price}" title="Chặn những người báo giá này và bỏ mọi báo giá của họ">Chặn</button></div>`).join("") : "—"}</td>
      <td><div class="btnrow"><input class="pricein" data-official="${i.id}" value="${i.announced?.source === "admin" ? i.announced.price.toLocaleString("vi-VN") : ""}" placeholder="vd 215k" aria-label="Giá chính thức">
        <button class="btn small" type="button" data-setprice="${i.id}">Lưu</button>
        ${i.announced?.source === "admin" ? `<button class="linkbtn" type="button" data-clearprice="${i.id}">Bỏ</button>` : ""}</div></td>
    </tr>`;
  };
  $("#revBody").innerHTML = `
    <div class="btnrow"><span class="adminnote">${r.stats.hidden} deal "Giá hấp dẫn" · ${r.stats.announced} đã có giá · ${waiting} chờ xác nhận · ${conflicts} có nhiều giá khác nhau</span>
      <label class="switch"><input type="checkbox" data-reports="${r.list.id}" ${r.list.reportsOpen ? "checked" : ""}> Cho người xem báo giá</label></div>
    ${r.items.length ? `<div class="tablewrap mt8"><table class="preview">
      <thead><tr><th>STT</th><th>Sản phẩm</th><th>Người xem báo</th><th>Giá chính thức</th></tr></thead>
      <tbody>${r.items.map(row).join("")}</tbody></table></div>`
    : `<p class="adminnote mt8">Chưa có ai báo giá cho deal list này.</p>`}`;
}
async function reviewAction(path, method, body, msg) {
  try {
    await api(path, { method, body: JSON.stringify(body) });
    if (msg) toast(msg);
  } catch (e) { toast(e.message); }
  loadReview(A.reviewId);
}

/* admin pastes a comment → official prices */
let official = [];
async function readOfficial() {
  const text = $("#offText").value.trim();
  if (!text) return;
  try {
    const r = await api(`/api/lists/${A.reviewId}/price-text`, { method: "POST", body: JSON.stringify({ text }) });
    official = r.matches.filter((m) => m.dealId).map((m) => ({ ...m, on: m.status === "ok" && m.current?.fileLive == null }));
    $("#offStatus").textContent = `Đọc được ${r.matches.length} giá${r.unread.length ? `, ${r.unread.length} dòng không đọc được` : ""}.`;
    renderOfficial();
  } catch (e) { $("#offStatus").textContent = e.message; }
}
function renderOfficial() {
  const n = official.filter((m) => m.on).length;
  $("#offResult").innerHTML = official.length ? `<div class="tablewrap mt8"><table class="preview">
    <thead><tr><th></th><th>STT</th><th>Sản phẩm</th><th>Giá</th><th>Ghi chú</th></tr></thead>
    <tbody>${official.map((m, i) => `<tr class="m-${m.status}"><td><input type="checkbox" data-off="${i}" ${m.on ? "checked" : ""} aria-label="Chọn STT ${m.stt}"></td>
      <td class="num">${m.stt}</td><td>${esc(m.name)}<div class="subtle">${esc(m.line)}</div></td><td class="num">${m.price.toLocaleString("vi-VN")}</td>
      <td>${m.current?.fileLive != null ? "Đã có giá trong file" : m.status === "check" ? `Tên không khớp${m.suggestion ? ` (giống #${m.suggestion.stt})` : ""}` : ""}</td></tr>`).join("")}</tbody></table></div>
    <button class="btn primary small mt8" type="button" id="offSave" ${n ? "" : "disabled"}>Đặt ${n} giá chính thức</button>` : "";
}

/** Status of the product-picture job of a list. */
function imagesText(l) {
  const im = l.images || {};
  if (im.state === "pending") return "";
  if (im.state === "done") return `${(l.stats?.pictures ?? 0).toLocaleString("vi-VN")} deal có ảnh${im.error ? ` (${esc(im.error)})` : ""}`;
  if (im.state === "failed") return `Không lấy được ảnh${im.error ? ` (${esc(im.error)})` : ""}`;
  return "";
}

/* A large panel for the picture job: a progress bar while it runs (so a quiet admin page isn't
   mistaken for an error), then a clear "done" or "failed" message. */
const imgSeen = new Map(); // listId → { t, done } first seen, for the time-left estimate
function imgPanel(l, inResult) {
  const im = l.images || {};
  const pics = (l.stats?.pictures ?? 0).toLocaleString("vi-VN");
  if (im.state === "pending") {
    const pct = im.total ? Math.round((im.done / im.total) * 100) : 0;
    let eta = "";
    const seen = imgSeen.get(l.id);
    if (!seen) imgSeen.set(l.id, { t: Date.now(), done: im.done });
    else if (im.done - seen.done >= 3 && im.total) {
      const perPage = (Date.now() - seen.t) / (im.done - seen.done);
      const secs = Math.round((perPage * (im.total - im.done)) / 1000);
      eta = secs > 90 ? ` · còn khoảng ${Math.round(secs / 60)} phút` : ` · còn khoảng ${Math.max(5, Math.round(secs / 5) * 5)} giây`;
    }
    return `<div class="imgprog" role="status">
      <div class="imgprog-head"><span class="spin" aria-hidden="true"></span><strong>Đang lấy ảnh sản phẩm từ file…</strong><span class="num">${pct}%</span></div>
      <progress class="bar" max="100" value="${pct}" aria-label="Tiến độ lấy ảnh">${pct}%</progress>
      <div class="imgprog-note">${im.total ? `Trang ${im.done}/${im.total}` : "Đang chuẩn bị…"}${l.stats?.pictures ? ` · ${pics} deal đã có ảnh` : ""}${eta}.
        ${inResult ? "Bạn có thể đăng ngay; ảnh hiện dần trên trang khi lấy xong từng trang." : "Ảnh hiện dần trên trang công khai."}</div>
    </div>`;
  }
  if (im.state === "failed") {
    return `<div class="imgprog failed" role="alert"><div class="imgprog-head"><strong>Không lấy được ảnh sản phẩm</strong></div>
      <div class="imgprog-note">${im.error ? esc(im.error) + ". " : ""}Deal list vẫn dùng được, chỉ thiếu ảnh. Xoá và nhập lại để thử lần nữa.</div></div>`;
  }
  if (im.state === "done" && inResult) {
    return `<div class="imgprog done" role="status"><div class="imgprog-head"><span aria-hidden="true">✓</span><strong>Đã lấy xong ảnh: ${pics} / ${(l.dealCount ?? 0).toLocaleString("vi-VN")} deal có ảnh</strong></div>
      ${im.error ? `<div class="imgprog-note">${esc(im.error)}</div>` : ""}</div>`;
  }
  return "";
}
const pictureSelector = (id) => `[data-imgprog="${id}"]`;
function paintImages(l) {
  document.querySelectorAll(pictureSelector(l.id)).forEach((el) => { el.innerHTML = imgPanel(l, el.dataset.inresult === "1"); });
  const s = document.querySelector(`[data-imgstate="${l.id}"]`);
  if (s) s.innerHTML = imagesText(l);
}

// While pictures are being cut out, refresh only the picture panels (no re-render: keeps inputs as they are).
let imgPoll = null;
function watchImages() {
  clearTimeout(imgPoll);
  if (!A.lists.some((l) => l.images?.state === "pending")) return;
  imgPoll = setTimeout(async () => {
    try {
      const before = new Map(A.lists.map((l) => [l.id, l.images?.state]));
      A.lists = (await api("/api/admin/lists")).lists;
      for (const l of A.lists) {
        paintImages(l);
        if (before.get(l.id) === "pending" && l.images?.state === "done") toast(`Đã lấy xong ảnh cho "${l.title}": ${(l.stats?.pictures ?? 0).toLocaleString("vi-VN")} deal có ảnh`, 5000);
        if (before.get(l.id) === "pending" && l.images?.state === "failed") toast(`Không lấy được ảnh cho "${l.title}"`, 5000);
      }
    } catch { /* try again next time */ }
    watchImages();
  }, 2000);
}

function itemHtml(l, i) {
  return `<div class="aitem" data-id="${l.id}">
    <div class="order">
      <button type="button" data-move="${i}|-1" aria-label="Lên" ${i === 0 ? "disabled" : ""}>▲</button>
      <button type="button" data-move="${i}|1" aria-label="Xuống" ${i === A.lists.length - 1 ? "disabled" : ""}>▼</button>
    </div>
    <div class="minw0">
      <input class="title" data-title="${l.id}" value="${esc(l.title)}" aria-label="Tên deal list" maxlength="200">
      <div class="sub"><span class="state ${l.published ? "pub" : "draft"}">${l.published ? "Đã đăng" : "Nháp"}</span>
        <span class="num">${l.dealCount} deal</span><span>${l.stats.brands} brand</span>${l.session ? `<span>${esc(l.session)}</span>` : ""}
        <span>${esc(l.source)}</span><span data-imgstate="${l.id}">${imagesText(l)}</span><a href="/#list-${l.id}" target="_blank" rel="noopener">Xem</a></div>
    </div>
    <div class="acts">
      <label class="switch"><input type="checkbox" data-publish="${l.id}" ${l.published ? "checked" : ""}> Đăng</label>
      <label class="switch"><input type="checkbox" data-pin="${l.id}" ${l.pinned ? "checked" : ""}> Ghim</label>
      <button class="iconbtn" type="button" data-del="${l.id}" title="Xoá deal list" aria-label="Xoá deal list">${ICON.trash}</button>
    </div>
    <div class="imgslot" data-imgprog="${l.id}">${imgPanel(l, false)}</div>
  </div>`;
}

function renderResult() {
  const box = $("#result");
  const r = A.last;
  if (!box || !r) return;
  const l = A.lists.find((x) => x.id === r.list.id) || r.list;
  box.innerHTML = `<div class="result">
    <div class="head"><strong>${esc(l.title)}</strong>
      <span class="num">${r.list.dealCount} deal · ${r.list.stats.brands} brand · ${r.list.voucherLabels.join(", ") || "không có cột voucher"}</span>
      <span class="state ${l.published ? "pub" : "draft"}">${l.published ? "Đã đăng" : "Nháp"}</span></div>
    <div data-imgprog="${l.id}" data-inresult="1">${imgPanel(l, true)}</div>
    ${r.warnings.length ? `<div class="warn">${r.warnings.map(esc).join("<br>")}</div>` : ""}
    <div class="tablewrap"><table class="preview">
      <thead><tr><th>STT</th><th>Brand</th><th>Tên sản phẩm</th><th>Giá live</th>${r.list.voucherLabels.map((v) => `<th>${esc(v)}</th>`).join("")}<th>Quà tặng</th><th>Trang</th></tr></thead>
      <tbody>${r.preview.map((d) => `<tr><td class="num">${d.stt}</td><td>${esc(d.brand)}</td><td>${esc(d.name)}</td><td class="num">${esc(d.liveRaw)}</td>
        ${d.voucherRaw.map((v) => `<td class="num">${esc(v)}</td>`).join("")}<td>${esc(d.gift)}</td><td class="num">${d.page ?? ""}</td></tr>`).join("")}</tbody>
    </table></div>
    <div class="adminnote">${r.preview.length} dòng đầu. ${r.hiddenPrice ? `${r.hiddenPrice} deal chưa có giá ("Giá hấp dẫn").` : ""} Kiểm tra cột có khớp không trước khi đăng.</div>
    <div class="btnrow">
      ${l.published ? "" : `<button class="btn primary" type="button" data-quick="${l.id}|pin">Đăng và ghim lên trang chủ</button><button class="btn" type="button" data-quick="${l.id}|pub">Chỉ đăng</button>`}
      <a class="btn" href="/#list-${l.id}" target="_blank" rel="noopener">Xem thử</a>
      <button class="btn danger" type="button" data-del="${l.id}">Xoá bản nhập này</button>
    </div>
  </div>`;
}

/* ---------- actions ---------- */
async function importFiles(files) {
  if (A.busy) return;
  A.busy = true;
  const status = $("#status");
  try {
    for (const file of files) {
      status.className = "status";
      status.textContent = `Đang đọc ${file.name} (${(file.size / 1048576).toFixed(1)} MB)…`;
      try {
        const r = await api("/api/admin/import", {
          method: "POST",
          body: file,
          headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name) },
        });
        A.last = r;
        status.className = "status ok";
        status.textContent = `Đã nhập ${r.list.dealCount} deal từ ${file.name} dưới dạng nháp.${r.list.images?.state === "pending" ? " Đang lấy ảnh sản phẩm, xem tiến độ bên dưới." : ""}`;
        A.lists = (await api("/api/admin/lists")).lists;
      } catch (e) {
        if (e.status === 401) return renderLogin("Phiên đăng nhập đã hết. Đăng nhập lại.");
        status.className = "status err";
        status.textContent = `${file.name}: ${e.message}`;
      }
    }
    const keep = status.outerHTML;
    render();
    $("#status").outerHTML = keep;
  } finally {
    A.busy = false;
  }
}

/** Import from a Google Drive / Sheets link. A folder link lists its files to pick from. */
async function importLink(url) {
  if (A.busy) return;
  A.busy = true;
  const status = $("#status");
  const btn = $("#linkBtn");
  status.className = "status";
  status.textContent = "Đang đọc file từ Google Drive… (file 100 trang mất khoảng 10 giây)";
  btn.disabled = true;
  try {
    const r = await api("/api/admin/import-link", { method: "POST", body: JSON.stringify({ url }) });
    if (r.folder) {
      status.textContent = r.folder.length
        ? `Thư mục có ${r.folder.length} file deal list. Chọn file để nhập:`
        : "Thư mục không có file PDF, Excel, CSV hay Google Sheets nào (hoặc chưa chia sẻ công khai).";
      $("#folderPick").innerHTML = r.folder.length ? `<div class="folderlist">${r.folder.map((f) =>
        `<button class="btn small" type="button" data-drivefile="${esc(f.url)}">${esc(f.name)}</button>`).join("")}</div>` : "";
      return;
    }
    A.last = r;
    A.lists = (await api("/api/admin/lists")).lists;
    render();
    const s = $("#status");
    s.className = "status ok";
    s.textContent = `Đã nhập ${r.list.dealCount} deal từ ${r.list.source} dưới dạng nháp.${r.list.images?.state === "pending" ? " Đang lấy ảnh sản phẩm, xem tiến độ bên dưới." : ""}`;
  } catch (e) {
    if (e.status === 401) return renderLogin("Phiên đăng nhập đã hết. Đăng nhập lại.");
    status.className = "status err";
    status.textContent = e.message;
  } finally {
    A.busy = false;
    if (btn.isConnected) btn.disabled = false;
  }
}

async function patch(id, body, okMsg) {
  try {
    await api(`/api/admin/lists/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    if (okMsg) toast(okMsg);
  } catch (e) {
    toast(e.message);
  }
  await refresh();
}

const pendingDelete = new Set();
document.addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  const d = t.dataset;
  if (t.id === "pickFile") return $("#file").click();
  if (d.drivefile) { $("#driveUrl").value = d.drivefile; return importLink(d.drivefile); }
  if (t.id === "offRead") return readOfficial();
  if (t.id === "offSave") {
    const items = official.filter((m) => m.on).map((m) => ({ dealId: m.dealId, price: m.price }));
    try {
      const r = await api("/api/admin/prices", { method: "POST", body: JSON.stringify({ items }) });
      toast(`Đã đặt ${r.saved} giá chính thức`);
      official = []; $("#offText").value = ""; $("#offStatus").textContent = ""; renderOfficial();
    } catch (err) { toast(err.message); }
    return loadReview(A.reviewId);
  }
  if (d.approve) { const [id, p] = d.approve.split("|").map(Number); return reviewAction(`/api/admin/deals/${id}/price`, "PUT", { price: p }, "Đã duyệt giá"); }
  if (d.reject) { const [id, p] = d.reject.split("|").map(Number); return reviewAction(`/api/admin/deals/${id}/reject`, "POST", { price: p }, "Đã từ chối giá này"); }
  if (d.block) { const [id, p] = d.block.split("|").map(Number); return reviewAction(`/api/admin/deals/${id}/block`, "POST", { price: p }, "Đã chặn người báo giá này"); }
  if (d.setprice) {
    const v = document.querySelector(`[data-official="${d.setprice}"]`).value;
    return reviewAction(`/api/admin/deals/${d.setprice}/price`, "PUT", { price: v }, "Đã lưu giá chính thức");
  }
  if (d.clearprice) return reviewAction(`/api/admin/deals/${d.clearprice}/price`, "PUT", { price: null }, "Đã bỏ giá chính thức");
  if (t.id === "logoutBtn") {
    await api("/api/admin/logout", { method: "POST" }).catch(() => {});
    t.hidden = true;
    return renderLogin();
  }
  if (d.quick) {
    const [id, mode] = d.quick.split("|");
    return patch(id, { published: true, pinned: mode === "pin" }, mode === "pin" ? "Đã đăng và ghim lên trang chủ" : "Đã đăng");
  }
  if (d.move) {
    const [i, dir] = d.move.split("|").map(Number);
    const ids = A.lists.map((l) => l.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { await api("/api/admin/lists/reorder", { method: "POST", body: JSON.stringify({ ids }) }); } catch (err) { toast(err.message); }
    return refresh();
  }
  if (d.del) {
    // two-step delete: first click arms, second click (within 4 s) deletes
    if (!pendingDelete.has(d.del)) {
      pendingDelete.add(d.del);
      t.classList.add("danger");
      t.title = "Bấm lần nữa để xoá vĩnh viễn";
      if (t.classList.contains("iconbtn")) t.classList.add("armed");
      else t.textContent = "Bấm lần nữa để xoá vĩnh viễn";
      toast("Bấm nút xoá lần nữa để xoá vĩnh viễn deal list này.");
      setTimeout(() => pendingDelete.delete(d.del), 4000);
      return;
    }
    pendingDelete.delete(d.del);
    try {
      await api(`/api/admin/lists/${d.del}`, { method: "DELETE" });
      if (A.last?.list.id === Number(d.del)) A.last = null;
      toast("Đã xoá deal list");
    } catch (err) { toast(err.message); }
    return refresh();
  }
});

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "file") { if (t.files.length) importFiles([...t.files]); t.value = ""; return; }
  if (t.id === "revList") return loadReview(t.value);
  if (t.dataset.off != null) { official[Number(t.dataset.off)].on = t.checked; return renderOfficial(); }
  if (t.dataset.reports) {
    return api(`/api/admin/lists/${t.dataset.reports}`, { method: "PATCH", body: JSON.stringify({ reportsOpen: t.checked }) })
      .then(() => toast(t.checked ? "Đã mở báo giá cho người xem" : "Đã tắt báo giá cho người xem"), (e) => toast(e.message))
      .then(() => loadReview(A.reviewId));
  }
  if (t.dataset.publish) return patch(t.dataset.publish, { published: t.checked }, t.checked ? "Đã đăng" : "Đã chuyển về nháp");
  if (t.dataset.pin) return patch(t.dataset.pin, { pinned: t.checked }, t.checked ? "Đã ghim" : "Đã bỏ ghim");
  if (t.dataset.title) {
    const l = A.lists.find((x) => x.id === Number(t.dataset.title));
    if (l && t.value.trim() && t.value.trim() !== l.title) patch(l.id, { title: t.value.trim() }, "Đã đổi tên");
  }
});
document.addEventListener("submit", (e) => {
  if (e.target.id !== "linkForm") return;
  e.preventDefault();
  importLink($("#driveUrl").value.trim());
});
document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.dataset?.title) e.target.blur(); });

document.addEventListener("dragover", (e) => {
  if ($("#drop") && e.dataTransfer?.types.includes("Files")) { e.preventDefault(); $("#drop").classList.add("over"); }
});
document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) $("#drop")?.classList.remove("over"); });
document.addEventListener("drop", (e) => {
  $("#drop")?.classList.remove("over");
  if ($("#drop") && e.dataTransfer?.files.length) { e.preventDefault(); importFiles([...e.dataTransfer.files]); }
});
start();
