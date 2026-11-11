# Sổ Săn Deal

A small website for livestream sale deal lists (11.11, 12.12…).

- **Admins** upload the deal-list file (PDF, Excel or CSV) or paste its Google Drive / Google Sheets link. The server reads the table, saves it to a database as a draft, and shows a preview. The admin then publishes it, pins it to the home page, renames it, reorders it or deletes it.
- **Everyone else** browses the published lists and filters them: accent-free search, brand, product group, final price after their voucher, gift, combo. They can keep a shopping list with a budget (stored in their own browser). Visitors can't change the deal lists.
  Deals keep the STT and the row order of the original file (shop files sometimes repeat an STT). A long list loads 60 deals at a time as you scroll. The site opens in light mode; the moon button switches to dark, remembered per browser.
- **Prices for "Giá hấp dẫn" deals are crowd-sourced.** Shops announce these prices later (in Facebook comments, on the live). Any visitor can report one, either a single price or by pasting the shop's comment, and other visitors confirm it with one tap. See [Crowd-sourced prices](#crowd-sourced-prices).

## Product pictures

After an import, the server cuts each deal's **Hình ảnh** (product) and **Hình ảnh quà tặng** (gift) pictures out of the file in the background. The admin list shows the progress ("Đang lấy ảnh sản phẩm · trang 34/100", then "2.180 deal có ảnh"). On the site, each deal shows a thumbnail; tap it to see it larger. Gift pictures sit next to the gift text, and the shopping list shows thumbnails too.

- **PDF files** (uploaded, or a downloadable Drive link): pdf.js gives every embedded image with its position, and the images inside one cell are drawn together (so "product + product" combos stay one picture).
- **View-only Drive files**: Drive's viewer serves each page as a picture (3200 px wide). Each image cell is cut between the table's grid lines and trimmed to the picture. 100 pages take about 1–2 minutes.
- **Excel / CSV**: no pictures yet.

Pictures are saved as WebP (at most 360 px) in `data/images/<list id>/` (`IMAGES_DIR`), served at `/img/…`, and deleted with their list. `npm run import` cuts them too (add `--no-images` to skip).

## Crowd-sourced prices

Many deals are listed as **"Giá hấp dẫn"** and the real price only appears later, in comments such as `STT 30 Combo 2 Nước tẩy trang tảo biển chỉ 215k`. There are too many for an admin alone, so visitors fill them in:

1. **Report.** On a deal without a price, a visitor clicks **Báo giá** and types the price (`215k`, `215.000`, `1tr2`…). Or they click **Dán giá từ bình luận** (paste prices from a comment), paste the whole comment, check the preview and send every line at once. The comment reader (`src/priceText.js`) understands `STT 30`, `#30`, `30.`, ranges such as `STT 30-32 đồng giá 199k` and lists such as `STT 30, 31`. It reads prices like `215k`, `215.000đ`, `1tr2`, `1,25 triệu`, and `chỉ 215` (= 215k). It ignores sizes and percentages (`500ml`, `25gx10`, `30%`). It also compares the words in the comment with the product name for that STT; if they don't match (shop typo), the line is unticked and the deal that does match is suggested.
2. **Confirm.** A reported price shows as **"Người xem báo · chưa xác nhận"** (reported by a viewer, not confirmed) with an **Đúng giá** (that's right) button. When `CONFIRM_VOTES` (default 2) different networks report the same price and no other price has as many votes, it becomes the deal's price: it shows as **Giá công bố** (announced price) and counts in filters, sorting and the shopping-list total.
3. **Review (admin).** `/admin` → **Giá các deal "Giá hấp dẫn"** lists every deal with reports, the ones with several different prices first. The admin can **Duyệt** (approve, making it the official price), **Từ chối** (reject a price), **Chặn** (block whoever reported a bad price and drop all their reports), type an official price, or paste the shop's comment to set many official prices at once. An official price always wins and locks the deal. **Cho người xem báo giá** (let viewers report prices) turns reporting on or off per list.

Abuse limits (in `src/db.js`, `REPORT_LIMITS`):
- Each browser has one report per deal; a new report replaces its old one.
- A vote is a distinct **network (IP)**, so one person with several browsers counts once.
- At most 3 browsers from one network can report the same deal.
- At most 60 reports per network every 10 minutes.
- Deals with a price in the file, or with an official price, can't be reported.

Only HMAC hashes of the browser id and the IP are stored, never the IP itself.

## Stack

| Part | Choice | Why |
|---|---|---|
| Server | Node.js 22 + Express 4 | one language front to back, tiny footprint |
| Database | SQLite via the built-in `node:sqlite` | a single file, nothing to install or compile |
| PDF reading | `pdfjs-dist` (text layer) | reads the deal table's real text, no OCR needed |
| Excel / CSV | SheetJS (`xlsx`) | `.xlsx`, `.xls`, `.csv` |
| Pictures | `sharp` (libvips) | cut, trim and shrink product pictures to WebP; prebuilt, nothing to compile |
| Frontend | plain HTML/CSS/JS modules | no build step; served by Express |
| Tests | `node:test` | built in |

## Run it

Requirements: **Node.js 22.13 or newer** (`node -v`).

```bash
npm install
```

```bash
copy .env.example .env
```

Edit `.env` and set `ADMIN_PASSWORD` (and `SESSION_SECRET` to a long random string). Then:

```bash
npm start
```

- Public site: http://localhost:3000
- Admin: http://localhost:3000/admin

During development, `npm run dev` restarts the server whenever a file changes.

## Adding a deal list

1. Open `/admin`, log in, and drop the file onto **Nhập deal list mới** (or click **Chọn file**).
2. Check the preview table: brand, product, prices and gift should sit in the right columns.
3. Click **Đăng và ghim lên trang chủ** (publish + pin), or **Chỉ đăng** (publish only).
4. In the list below you can rename a list, turn **Đăng** / **Ghim** on or off, move it up or down (home-page order), or delete it (click the bin twice).

### From a Google Drive link

Under the drop zone, paste the link and click **Nhập từ link** (import from link). It accepts:

- a file link: `https://drive.google.com/file/d/…/view?usp=sharing` (PDF, Excel or CSV);
- a Google Sheets link: `https://docs.google.com/spreadsheets/d/…` (exported as Excel);
- a folder link: `https://drive.google.com/drive/folders/…`. The files in it are listed, and you pick one.

The file must be shared as **"Anyone with the link"** (the server doesn't sign in to Google). If the owner turned off downloading (common for shop deal lists), the server reads the PDF's text from Drive's own viewer instead. That takes about 10 seconds for 100 pages. A view-only Excel file can't be read this way: download it and upload the file. The server only requests Google addresses that it builds from the file id (`src/drive.js`).

From the command line (useful for scripts or first-time seeding), with a file or a Drive link:

```bash
npm run import -- "DEAL LIST 11.11.pdf" --title "Superlive 11.11" --publish --pin
```

```bash
npm run import -- "https://drive.google.com/file/d/FILE_ID/view" --publish
```

### What file format works

The PDF must have a **text layer** (exported from Excel/Sheets/Word, not a scanned photo) and a table whose header row contains these columns, in any order:

`STT` · `BRAND` · `Tên sản phẩm` · `Hình ảnh` · `Giá livestream` · `Giá sau voucher NN%` (any number of these) · `Quà tặng` · `Hình ảnh quà tặng`

Optional columns that are also picked up: `Giá gốc` (original price) and `Phân loại` / `Ghi chú` (note). Headers can repeat on every page, merged BRAND cells are filled down, the event title above the table (e.g. "SUPERLIVE 20H 11/11") becomes the list's session label, and "Giá hấp dẫn" is kept as "price announced on the live". Excel/CSV files need the same header names; CSV must be UTF-8.

## API

Public:

| Method | Path | Notes |
|---|---|---|
| GET | `/api/lists` | published lists, home-page order, with stats |
| GET | `/api/lists/:id` | one list |
| GET | `/api/deals` | `list=<id>\|all`, `q`, `brands`, `cats`, `lists` (comma-separated), `gift=1`, `priced=1`, `needPrice=1`, `combo=1`, `min`, `max`, `pick=best\|live\|v0\|v1…`, `sort=stt\|save\|asc\|desc\|brand`, `group=1`, `offset`, `limit` (max 500). Returns `items`, `total`, `facets`, `insights`, `voucherLabels`. |

Price reports (public; need the header `X-Requested-With: fetch`):

| Method | Path | Notes |
|---|---|---|
| POST | `/api/reports` | `{ dealId, price, source? }`. `price` may be `"215k"`, `"1tr2"` or `215000`. Reporting a price someone else reported counts as confirming it. |
| POST | `/api/reports/bulk` | `{ items: [{ dealId, price }], source? }` (max 200) |
| POST | `/api/lists/:id/price-text` | `{ text }`: reads prices out of comment text without saving. Returns `matches` and `unread` lines. |

Admin (login cookie required; non-GET requests also need the header `X-Requested-With: fetch`):

| Method | Path | Notes |
|---|---|---|
| POST | `/api/admin/login` | `{ "password": "…" }` |
| POST | `/api/admin/logout` | |
| GET | `/api/admin/me` | `{ admin, enabled }` |
| GET | `/api/admin/lists` | all lists, drafts included |
| POST | `/api/admin/import` | body = raw file bytes, header `X-Filename` (URI-encoded); optional `X-Title`. Creates a **draft**. |
| POST | `/api/admin/import-link` | `{ url, title? }`: a Google Drive file or Google Sheets link creates a **draft** (same answer as `/import`). A folder link answers `{ folder: [{ id, name, kind, url }] }`. |
| PATCH | `/api/admin/lists/:id` | `{ title?, published?, pinned?, reportsOpen? }` |
| POST | `/api/admin/lists/reorder` | `{ "ids": [3, 1, 2] }` |
| DELETE | `/api/admin/lists/:id` | deletes the list and its deals |
| GET | `/api/admin/lists/:id/reviews` | deals with viewer reports or official prices |
| PUT | `/api/admin/deals/:id/price` | `{ price }` sets the official price; `{ price: null }` clears it |
| POST | `/api/admin/prices` | `{ items: [{ dealId, price }] }` sets many official prices |
| POST | `/api/admin/deals/:id/reject` | `{ price }` rejects that reported price |
| POST | `/api/admin/deals/:id/block` | `{ price }` blocks whoever reported it |

## Project layout

```
src/
  server.js        starts the HTTP server (reads .env)
  app.js           routes, security headers, static files
  auth.js          admin login: password check, signed HttpOnly cookie, login rate limit
  db.js            SQLite schema/migrations + in-memory cache of deals per list
  deals.js         categories, voucher prices, search / filters / facets / insights
  priceText.js     reads STT + price out of comment text; typed prices (215k, 1tr2)
  drive.js         Google Drive / Sheets links: download, or read a view-only PDF from Drive's viewer
  images.js        product / gift pictures: cut from page pictures, or taken from a PDF's embedded images
  imageJob.js      runs picture extraction after an import (one list at a time) and records progress
  text.js          accent-insensitive Vietnamese text helpers
  parser/
    index.js       file → rows (pdf.js for PDF, SheetJS for Excel/CSV)
    table.js       the table reader: header columns, rows by STT, page furniture removal
public/
  index.html, js/public.js   public site
  admin.html, js/admin.js    admin page
  app.css, js/util.js        shared
scripts/import.js            command-line import
scripts/pack.js              packs code (+ data snapshot) for deploying
deploy/                      server setup / update scripts and the hosting guide (DEPLOY.md)
test/                        parser, deal-search, Drive-link and API tests (+ a sample deal-list PDF)
data/                        the SQLite database and data/images/ (created on first start, not committed)
```

## Tests

```bash
npm test
```

`test/fixtures/deal-sample.pdf` is a 45-row deal list laid out like the real ones; the parser test checks every cell of it. `test/fixtures/make-sample-pdf.js` regenerates it with headless Chrome. `test/fixtures/deal-pictures.pdf` (6 rows with real embedded pictures) is made by `make-pictures-pdf.js` the same way.

## Deploying

**On your Windows PC with your own domain: [deploy/WINDOWS.md](deploy/WINDOWS.md)** (Cloudflare Tunnel; `deploy/windows/install-windows.ps1` makes the site start with Windows, keeps it running and backs up the database nightly; `npm run backup` makes a backup by hand).

**Free, step by step: [deploy/DEPLOY.md](deploy/DEPLOY.md)** (Oracle Cloud Always Free server). On your PC, `npm run deploy:pack -- --data` packs the code and a snapshot of your data. On the server, `sudo bash setup.sh so-san-deal.tgz --domain your.domain --data so-san-deal-data.tgz` installs everything: Node 22, a systemd service, Caddy with automatic HTTPS, firewall rules and daily database backups. `update.sh` puts a new version live, and rolls back if it doesn't start.

Any other host that runs Node 22 and keeps a persistent disk works (a small VPS, Railway/Render/Fly with a volume). Point `DB_PATH` at the persistent disk, set `ADMIN_PASSWORD` and `SESSION_SECRET`, put it behind HTTPS and set `COOKIE_SECURE=1`. Set `TRUST_PROXY` to match your proxy (for example `1` on Render, Railway or Fly). Otherwise every visitor looks like the same network, and price votes never reach 2. Back up by copying the `.db` file.

## Known limits

- One admin password (no per-user accounts).
- Price votes are counted per network. Two real people on the same Wi-Fi count as one vote, and someone who switches networks (Wi-Fi ↔ 4G) could vote twice. The admin review queue and blocking cover this.
- A viewer-reported price only fills the livestream price; the voucher prices for that deal are not calculated.
- Scanned PDFs (images only) can't be read; they need a text layer.
- Reading view-only Drive files relies on how Drive's viewer serves page text. That isn't a public API, so if Google changes it, the import says it can't read the file. Downloading the file and uploading it still works.
- Product categories come from keyword rules in `src/deals.js` (`CATEGORIES`); extend them as new product types show up.
