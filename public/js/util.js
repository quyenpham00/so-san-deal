// Small helpers shared by the public and admin pages.
export const $ = (s, el = document) => el.querySelector(s);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const fmt = (n) => (n == null ? "" : Math.round(n).toLocaleString("vi-VN"));
export const norm = (s) => String(s ?? "").normalize("NFC").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

/** "215k", "215.000đ", "1.890.000", "1tr2", "1,25 triệu" → number (null if unreadable) */
export function parsePrice(raw) {
  const t = String(raw ?? "").trim().toLowerCase();
  const mil = t.replace(/\s/g, "").match(/^(\d+(?:[.,]\d+)?)(tr|triệu|trieu|củ|cu)(\d{1,3})?$/);
  if (mil) return Math.round(Number(mil[1].replace(",", ".")) * 1e6 + (mil[3] ? Number(mil[3].padEnd(3, "0")) * 1000 : 0));
  const c = t.replace(/\s/g, "").replace(/(vnd|vnđ|đ|d)$/i, "");
  const m = c.match(/^(\d{1,3}(?:[.,]\d{3})+|\d+)(k)?$/i);
  if (!m) return null;
  return Number(m[1].replace(/[.,]/g, "")) * (m[2] ? 1000 : 1);
}

export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

export async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { ...(opts.body && !(opts.body instanceof Blob) ? { "Content-Type": "application/json" } : {}), "X-Requested-With": "fetch", ...opts.headers },
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Lỗi ${res.status}`), { status: res.status });
  return data;
}

let toastTimer;
export function toast(msg, ms = 2800) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

/** Highlight accent-insensitive matches of the query terms in text. */
export function highlight(text, q) {
  const terms = norm(q).split(/\s+/).filter((t) => t.length > 1);
  const s = String(text ?? "").normalize("NFC");
  if (!terms.length) return esc(s);
  const n = norm(s);
  if (n.length !== s.length) return esc(s);
  const mark = new Array(s.length).fill(false);
  for (const t of terms) for (let i = n.indexOf(t); i >= 0; i = n.indexOf(t, i + t.length)) for (let k = i; k < i + t.length; k++) mark[k] = true;
  let out = "", open = false;
  for (let i = 0; i < s.length; i++) {
    if (mark[i] !== open) { out += mark[i] ? "<mark>" : "</mark>"; open = mark[i]; }
    out += esc(s[i]);
  }
  return out + (open ? "</mark>" : "");
}
