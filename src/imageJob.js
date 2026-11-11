// Runs picture extraction for an imported list, one list at a time, and records progress
// on the list (images_state / images_done / images_total) so the admin page can show it.
import { picturesFromPageImages, picturesFromPdf } from "./images.js";

/**
 * What a list's pictures can be taken from:
 * - { pdf: Buffer }                         a PDF's bytes (embedded images)
 * - { pages, pagePng: async (pageNo) => PNG } Drive viewer page pictures
 * Anything else (Excel, CSV) has no pictures to take.
 */
export function pictureSource({ buffer, filename, pages, pagePng }) {
  if (pagePng && pages) return { pages, pagePng };
  if (buffer && (/\.pdf$/i.test(filename || "") || buffer.subarray(0, 5).toString("latin1") === "%PDF-")) return { pdf: buffer };
  return null;
}

export function createImageJobs({ store, images, log = console }) {
  let chain = Promise.resolve();

  /** Extract pictures for a list now (awaitable). */
  async function run(listId, rows, source) {
    const deals = store.deals(listId);
    // rows were saved in order, so row i is deal i
    const dealIds = deals.map((d) => d.id);
    if (dealIds.length !== rows.length) throw new Error("rows and deals differ");
    const onPage = (done, total) => { if (store.list(listId)) store.setImagesState(listId, { done, total }); };
    let saved = 0;
    // save each page's pictures as soon as it's cut, so they show on the site while the job runs
    const onPictures = async (found) => {
      if (!found.size || !store.list(listId)) return; // nothing here, or the list was deleted meanwhile
      const flags = new Map();
      for (const [dealId, got] of found) {
        let f = 0;
        if (got.p) { await images.save(listId, dealId, "p", got.p); f |= 1; }
        if (got.g) { await images.save(listId, dealId, "g", got.g); f |= 2; }
        flags.set(dealId, f);
      }
      store.setDealImages(listId, flags);
      saved += flags.size;
    };
    store.setImagesState(listId, { state: "pending", done: 0, total: 0, error: "" });
    try {
      const found = source.pdf
        ? await picturesFromPdf({ buffer: source.pdf, rows, dealIds, onPage, onPictures })
        : await picturesFromPageImages({ rows, dealIds, pages: source.pages, pagePng: source.pagePng, onPage, onPictures });
      if (!store.list(listId)) { await images.removeList(listId); return { saved: 0 }; } // deleted meanwhile
      const skipped = found.skipped || [];
      store.setImagesState(listId, { state: "done", error: skipped.length ? `bỏ qua ${skipped.length} trang không tải được: ${skipped.slice(0, 10).join(", ")}${skipped.length > 10 ? "…" : ""}` : "" });
      return { saved };
    } catch (e) {
      log.error?.(`pictures for list ${listId}:`, e);
      if (store.list(listId)) store.setImagesState(listId, { state: "failed", error: e.message || "lỗi" });
      return { saved: 0, error: e };
    }
  }

  /** Queue extraction in the background; returns the promise of this list's job. */
  function start(listId, rows, source) {
    if (!source) return Promise.resolve({ saved: 0 });
    store.setImagesState(listId, { state: "pending", done: 0, total: 0, error: "" });
    const job = chain.then(() => run(listId, rows, source));
    chain = job.catch(() => {});
    return job;
  }

  return { start, run, idle: () => chain };
}
