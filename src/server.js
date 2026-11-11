import path from "node:path";
import { openDb } from "./db.js";
import { createApp } from "./app.js";

const port = Number(process.env.PORT) || 3000;
const dbPath = process.env.DB_PATH || "data/so-san-deal.db";
const store = openDb(dbPath);

if (!process.env.ADMIN_PASSWORD) {
  console.warn("! ADMIN_PASSWORD is not set: the admin page is disabled. Copy .env.example to .env and set it.");
}
if (process.env.ADMIN_PASSWORD && !process.env.SESSION_SECRET) {
  console.warn("! SESSION_SECRET is not set: admins will be logged out whenever the server restarts.");
}

const app = createApp({
  store,
  adminPassword: process.env.ADMIN_PASSWORD,
  sessionSecret: process.env.SESSION_SECRET,
  secureCookie: process.env.COOKIE_SECURE === "1",
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB) || 40,
  // product / gift pictures cut out of imported files (default: next to the database)
  imagesDir: process.env.IMAGES_DIR || path.join(path.dirname(dbPath), "images"),
  trustProxy: /^\d+$/.test(process.env.TRUST_PROXY || "") ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY || "loopback",
});

// HOST=127.0.0.1 behind a reverse proxy on the same machine (the deploy script sets it)
const host = process.env.HOST || undefined;
const server = app.listen(port, host, () => {
  console.log(`Sổ Săn Deal running at http://localhost:${port}  (admin: http://localhost:${port}/admin)`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
