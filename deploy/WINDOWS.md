# Hosting Sổ Săn Deal on your Windows PC, with your own domain

Your PC runs the site; a **Cloudflare Tunnel** connects it to your domain. Visitors get HTTPS, and you don't open any port on your router or reveal your home IP. That matters in Vietnam, where home internet often can't receive incoming connections.

The only cost is the domain. Cloudflare's tunnel and DNS are free.

Time: about 30 minutes.

---

## 1. Buy a domain

The easiest is **Cloudflare Registrar** (https://dash.cloudflare.com → *Domain Registration* → *Register Domains*): you pay what the registry charges, with no markup, and **renewals cost the same as the first year**. A `.com` is about US$10–11 a year.

Elsewhere (Namecheap, Porkbun, …) some endings like `.xyz`, `.site` or `.online` cost US$1–3 for the **first year**, but **check the renewal price**, often US$10–30 a year. If you buy elsewhere, add the domain to Cloudflare (free plan) and set the two nameservers Cloudflare shows you at the seller. That takes minutes to a few hours.

Tip: a short, easy name like `sansdeal.com` or `sosandeal.xyz`.

## 2. Make the site start with Windows

1. If `npm start` is running in a terminal, stop it (Ctrl+C).
2. Open **PowerShell as Administrator** (Start → type *PowerShell* → *Run as administrator*).
3. Run:

```powershell
cd "C:\Users\Quyen Pham\Documents\PERSONAL PROJECTS\so-san-deal"
```

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\install-windows.ps1
```

The script:
- sets three values in `.env` for the tunnel (`HOST=127.0.0.1`, `COOKIE_SECURE=1`, `TRUST_PROXY=loopback`). Your password is kept, and the old file is saved as `.env.bak`;
- adds a scheduled task **SoSanDeal-Server** that starts the site at boot, even before you log in, and restarts it if it stops;
- adds **SoSanDeal-Backup**, which backs up the database every night at 03:00 to `data\backups\` and keeps 14 days;
- starts the site and checks it answers on http://127.0.0.1:3000.

To remove it later: `powershell -ExecutionPolicy Bypass -File deploy\windows\install-windows.ps1 -Uninstall`. That removes the tasks only; your data stays.

> `COOKIE_SECURE=1` means the admin login only works over HTTPS, so after this step log in through your domain, not `http://localhost:3000`.

## 3. Connect the domain with a Cloudflare Tunnel

1. Install the tunnel program, in the same Administrator PowerShell:

   ```powershell
   winget install --id Cloudflare.cloudflared
   ```

   Close and reopen PowerShell as Administrator afterwards.
2. Open the **Cloudflare Zero Trust** dashboard: https://one.dash.cloudflare.com. The first time, pick a team name and the **Free** plan.
3. Go to **Networks → Tunnels → Create a tunnel → Cloudflared**. Name it `so-san-deal`, then choose **Windows**.
4. Cloudflare shows a command like `cloudflared.exe service install eyJh…`. Copy it and run it in the Administrator PowerShell. This installs the tunnel as a Windows service that starts with the PC. **Don't share that token**: it controls your tunnel.
5. Back in the dashboard, under **Public Hostname** add:
   - Subdomain: *(empty)*, Domain: *your domain*, Type **HTTP**, URL **localhost:3000**
   - (optional) a second one with Subdomain `www`, same settings
6. Save. After a minute, open `https://your-domain` and `https://your-domain/admin`.

## 4. Keep the PC available

- **Settings → System → Power → Screen and sleep → When plugged in, put my device to sleep after: Never.** A screen that turns off is fine; sleep isn't.
- **Windows Update:** set *active hours* so restarts happen at night. After a restart, the site and the tunnel come back by themselves.
- Optional: in the PC's BIOS, *Restore on AC power loss → Power On*, so the PC starts again after a power cut.

## Day-to-day

| What | How |
|---|---|
| Logs | `data\logs\server-YYYY-MM.log` |
| Restart the site | Task Scheduler → *SoSanDeal-Server* → End, then Run. Or in Administrator PowerShell: `Stop-ScheduledTask SoSanDeal-Server; Start-ScheduledTask SoSanDeal-Server` |
| After changing the code | restart the site as above |
| Backups | `data\backups\db-YYYY-MM-DD.db` (14 days). Copy one somewhere else from time to time (USB, Google Drive) |
| Check the tunnel | Zero Trust dashboard → Networks → Tunnels: status should be **Healthy** |

## Good to know

- **Uploads:** Cloudflare's free plan accepts uploads up to 100 MB, more than the app's 40 MB limit.
- **Visitor IPs** for price votes are read correctly: the tunnel runs on the same PC, and the app trusts it.
- **Security:** only the tunnel can reach the app (`HOST=127.0.0.1`). Keep Windows updated and use a strong admin password (`ADMIN_PASSWORD` in `.env`, then restart the site).
- **When the PC is off,** the site is down: Cloudflare shows an error page until it's back. For always-on hosting, see [DEPLOY.md](DEPLOY.md) (Oracle Cloud free server).
