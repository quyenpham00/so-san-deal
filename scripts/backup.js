// Daily backup of the database: a consistent copy (VACUUM INTO, safe while the server runs)
// in <data folder>/backups/db-YYYY-MM-DD.db; copies older than KEEP_DAYS are deleted.
//   npm run backup
import { mkdirSync, readdirSync, rmSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS) || 14;
const dbPath = path.resolve(process.env.DB_PATH || "data/so-san-deal.db");
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath}`);
  process.exit(1);
}
const dir = path.join(path.dirname(dbPath), "backups");
mkdirSync(dir, { recursive: true });

const day = new Date().toISOString().slice(0, 10);
const out = path.join(dir, `db-${day}.db`);
rmSync(out, { force: true }); // VACUUM INTO refuses to overwrite
const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();
console.log(`backup: ${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`);

const cutoff = Date.now() - KEEP_DAYS * 86400_000;
for (const f of readdirSync(dir)) {
  if (/^db-\d{4}-\d{2}-\d{2}\.db$/.test(f) && statSync(path.join(dir, f)).mtimeMs < cutoff) {
    rmSync(path.join(dir, f));
    console.log(`removed old backup ${f}`);
  }
}
