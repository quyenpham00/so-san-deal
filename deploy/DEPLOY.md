# Hosting Sổ Săn Deal for free on Oracle Cloud

Oracle Cloud's **Always Free** tier gives you a small Linux server that stays on, with a disk that keeps the database and pictures. You sign up and create the server yourself (steps 1–3); the scripts in this folder do the rest.

Time: about 30–45 minutes the first time.

> Check Oracle's current Always Free limits before you start: reports from mid-2026 say the free Arm allowance was cut from 4 cores / 24 GB to **2 cores / 12 GB** in total. This app needs far less: 1 core / 1–6 GB is plenty.

---

## 1. Sign up

1. Go to https://www.oracle.com/cloud/free/ and click **Start for free**.
2. Pick a **home region** close to your visitors (for Vietnam: *Singapore* or *Japan East (Tokyo)*). You can't change it later, and free servers can only be created there.
3. Oracle asks for a card **to verify your identity**. Always Free resources aren't charged. (You may see a small temporary hold.)

## 2. Create the server

In the Oracle Cloud console: **☰ → Compute → Instances → Create instance**.

| Setting | Value |
|---|---|
| Name | `so-san-deal` |
| Image | **Canonical Ubuntu 24.04** (click *Change image*) |
| Shape | **Ampere → VM.Standard.A1.Flex**, 1 OCPU, 6 GB memory (stays inside the free limit). If you get *"Out of capacity"*, try again later, try another availability domain, or pick **VM.Standard.E2.1.Micro** (AMD, also free, 1 GB: enough for this app). |
| Networking | Usually you only check this section, without changing anything (see *Networking, step by step* below the table) |
| SSH keys | **Generate a key pair for me** → **Save private key** (keep this file safe: it's how you log in) |

**Networking, step by step.** The *Networking* section gives your server a private network inside Oracle, plus an internet address so visitors can reach it. On a new account the defaults are already right; just check:

1. **Primary network:** *Create new virtual cloud network* (the private network). If you created one before, *Select existing virtual cloud network* is fine too.
2. **Subnet:** *Create new public subnet*. It must be **public**, not private, or the next option stays greyed out.
3. **Public IPv4 address:** the box named *Automatically assign public IPv4 address* (or *Assign a public IPv4 address*) must be **checked** or **On**. This is the address you'll put in your browser and point your domain to. Without it the server has no internet address.
4. Leave the other fields (names, private IP, IPv6) as they are.

Click **Create**, wait until it's *Running*, and copy the **Public IP address**. If the page shows `—` instead of an address, step 3 was off. Go to the instance's **Attached VNICs** → the VNIC → **IP Administration** → the ⋯ menu → **Edit** → **Ephemeral public IP**.

## 3. Open the web ports (80 and 443)

The server's own firewall is handled by the setup script, but Oracle also has a cloud firewall:

1. On the instance page, click the **Subnet** link → **Security** (or *Security Lists*) → the *Default Security List*.
2. **Add Ingress Rules**, twice:
   - Source CIDR `0.0.0.0/0`, IP protocol **TCP**, destination port **80**
   - Source CIDR `0.0.0.0/0`, IP protocol **TCP**, destination port **443**

## 4. (Recommended) A free domain name, for HTTPS

Without a domain the site works on `http://<IP>`, but the admin password is sent **unencrypted**. A free subdomain fixes that:

1. Go to https://www.duckdns.org, sign in, and create a subdomain, e.g. `sosandeal` → `sosandeal.duckdns.org`.
2. Put the server's **Public IP** in the *current ip* box and click **update ip**.

(Any domain you own works too: point an `A` record to the IP.)

## 5. Pack the app on your PC

In the project folder:

```bash
npm run deploy:pack -- --data
```

This creates two files in `deploy/out/`:

- `so-san-deal.tgz`: the code (no passwords, no `node_modules`)
- `so-san-deal-data.tgz`: a snapshot of your current deal lists, price reports and pictures. Leave out `-- --data` if you want to start the server empty.

## 6. Copy it to the server and run the setup

Replace `KEY` with the private key file from step 2 and `IP` with the server's IP. On Windows, run these in PowerShell or Git Bash.

```bash
scp -i KEY deploy/out/so-san-deal.tgz deploy/out/so-san-deal-data.tgz deploy/setup.sh deploy/update.sh ubuntu@IP:~
```

```bash
ssh -i KEY ubuntu@IP
```

On the server (with your DuckDNS name; leave out `--domain …` if you skipped step 4):

```bash
sudo bash setup.sh so-san-deal.tgz --domain sosandeal.duckdns.org --data so-san-deal-data.tgz
```

It takes 2–5 minutes and ends with the site address and a **new admin password**. Save the password: it's different from the one on your PC. (You can see it again later with `sudo cat /etc/so-san-deal/env`.)

Open `https://sosandeal.duckdns.org` (the first visit can take ~30 s while the HTTPS certificate is issued) and `…/admin`.

> If Windows says *"permissions for KEY are too open"*: right-click the key file → Properties → Security → Advanced → disable inheritance and leave only your own user.

## Updating the site later

After changing the code on your PC:

```bash
npm run deploy:pack
```

```bash
scp -i KEY deploy/out/so-san-deal.tgz ubuntu@IP:~
```

```bash
ssh -i KEY ubuntu@IP "sudo bash update.sh so-san-deal.tgz"
```

Settings, the database and pictures are kept. If the new version doesn't start, the previous one is put back automatically.

## Day-to-day

| What | Command (on the server) |
|---|---|
| See the logs | `sudo journalctl -u so-san-deal -f` |
| Restart | `sudo systemctl restart so-san-deal` |
| Change settings (password, votes…) | `sudo nano /etc/so-san-deal/env`, then restart |
| Backups | every day in `/var/lib/so-san-deal/backups/` (14 days kept) |
| Download a backup to your PC | `scp -i KEY ubuntu@IP:/var/lib/so-san-deal/backups/db-YYYY-MM-DD.db .` |

## Things to know

- **Idle reclaim:** Oracle may stop Always Free servers it considers idle (very low CPU, network and memory use over a week). A small site can look idle. To avoid this, upgrade the account to **Pay As You Go** (Billing → Upgrade): Always Free resources stay free, and the reclaim rule no longer applies. Set a budget alert at $1 if you want to be sure nothing is charged.
- **Pictures** live in `/var/lib/so-san-deal/images`. The daily backup covers the database only; pictures can be re-made by importing the deal list again.
- **Google Drive imports** run from the server, so they work the same as on your PC.
- **Visitor IPs** (for price votes) are read correctly: Caddy runs on the same server and the app trusts it (`TRUST_PROXY=loopback`).
