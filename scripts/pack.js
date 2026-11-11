// Packs the app (and optionally its data) for copying to a server.
//   npm run deploy:pack            → deploy/out/so-san-deal.tgz        (code only, no secrets)
//   npm run deploy:pack -- --data  → also deploy/out/so-san-deal-data.tgz (database snapshot + pictures)
// The database snapshot is taken with VACUUM INTO, so it is consistent even while the server runs.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, cpSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "deploy", "out");
mkdirSync(out, { recursive: true });

// Only what the server needs: no node_modules, .env, data, tests or editor files.
const APP = ["package.json", "package-lock.json", "src", "public", "scripts", "deploy/setup.sh", "deploy/update.sh", ".env.example", "README.md"];
for (const p of APP) if (!existsSync(path.join(root, p))) throw new Error(`missing ${p}`);
const appTgz = path.join(out, "so-san-deal.tgz");
// relative paths + cwd: GNU tar (Git Bash) would read "C:…" as a remote host
execFileSync("tar", ["-czf", path.relative(root, appTgz).split(path.sep).join("/"), ...APP], { cwd: root, stdio: "inherit" });
console.log(`app:  ${path.relative(root, appTgz)} (${(statSync(appTgz).size / 1024).toFixed(0)} KB)`);

if (process.argv.includes("--data")) {
  const dbPath = path.resolve(root, process.env.DB_PATH || "data/so-san-deal.db");
  const imagesDir = path.resolve(root, process.env.IMAGES_DIR || path.join(path.dirname(dbPath), "images"));
  if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
  const stage = path.join(out, "data-stage");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const snap = path.join(stage, "so-san-deal.db");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
  db.close();
  if (existsSync(imagesDir)) cpSync(imagesDir, path.join(stage, "images"), { recursive: true });
  const dataTgz = path.join(out, "so-san-deal-data.tgz");
  execFileSync("tar", ["-czf", path.relative(stage, dataTgz).split(path.sep).join("/"), "."], { cwd: stage, stdio: "inherit" });
  rmSync(stage, { recursive: true, force: true });
  console.log(`data: ${path.relative(root, dataTgz)} (${(statSync(dataTgz).size / 1048576).toFixed(1)} MB) — database snapshot + pictures`);
}
