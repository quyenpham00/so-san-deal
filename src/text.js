// Accent-insensitive Vietnamese text helpers (shared by parser, tagging and search).

/** "Tẩy Trang Đào" → "tay trang dao" (same length as the NFC input) */
export function norm(s) {
  return String(s ?? "")
    .normalize("NFC")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

/** Split a query into accent-free search terms. */
export function terms(q) {
  return norm(q).split(/\s+/).filter(Boolean);
}
