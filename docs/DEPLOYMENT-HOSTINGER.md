# Deploying to Hostinger from GitHub

The site is one Node.js app. Hostinger pulls it from GitHub, runs
`npm install`, `npm run build`, then `npm start`.

Nothing here needs Docker, Redis, a queue server or compiled native modules.

## Part 0: How Hostinger Business runs this app, and what the app does about it

| Hostinger Business | What the app does |
|---|---|
| Node.js 18, 20, 22 or 24, chosen in hPanel. | Use **22**. `package.json` requires 20.6 or newer (`engines`), because the cron script needs `--env-file`. |
| The app runs from `~/domains/<domain>/hbuilds/current/nodejs`. Each deploy builds a new copy, and **`hbuilds/` and `public_html/` are replaced** on every deploy. | No data lives in the app folder. In production the start-up check refuses a data path inside the app folder, `hbuilds` or `public_html`. Use folders directly under your home (Part 3). |
| The app is started on demand and stopped when idle. A request is stopped after **120 s**. There is no always-running worker, no WebSocket, no custom port, no Docker and no Redis. | Background work runs from **Hostinger Cron Jobs** (`JOBS_MODE=cron`; see Part 6 and `docs/unified/BACKGROUND-JOBS.md`). Screens poll; nothing needs a socket. |
| One MySQL server per plan. | One pooled connection set, server-side pagination, short transactions, and retries on deadlock. |
| The plan has limits on processes (120) and entry processes (60). | One app process. Cron runs are finite and lock against each other, so they never pile up. |
| No one-click "roll back to a commit". | Roll back by redeploying an older commit from GitHub (see "Rolling back"). Data is backed up separately. |

**Before every deploy**, run the release gate on your computer or check that the GitHub "quality-gate" run is green.
The gate is `node scripts/release-gate.js`; see `docs/unified/reports/TEST-REPORT.md`. Deploy only a green commit.

> Menu names in hPanel change from time to time. If a label below does not
> match what you see, look for the nearest equivalent.

---

## Part 1 — Deploy the code with B2B switched off (safe, changes nothing)

Do this first. With `B2B_ENABLED=false` the customer website behaves exactly
as it did before.

1. **Back up first.** Download your current data folder (`DATA_DIR`, by
   default `~/sakeofhealth-data`) from hPanel → File Manager.
2. Push this code to your GitHub repository (see "GitHub" below).
3. In hPanel open your Node.js app and check:

   | Setting | Value |
   |---|---|
   | Node.js version | 20 or 22 |
   | Install command | `npm install` |
   | Build command | `npm run build` |
   | Start command | `npm start` |
   | Entry file | `index.js` |

4. Keep every environment variable you already have. Do **not** add
   `B2B_ENABLED` yet (or set it to `false`).
   While you are there, confirm `ADMIN_JWT_SECRET` is set to a long random
   value and `ADMIN_PASSWORD` is strong: the same admin login now also opens
   pricing, credit and business documents.
   **Also open Admin → Staff.** The original site seeds four demo staff
   accounts (manager@, ravi@, sunil@, support@sakeofhealth.com) whose
   passwords are written in `src/seed.js`, and therefore in your GitHub
   repository. If they exist on the live site, change their passwords or
   deactivate them before switching B2B on — a "manager" can change prices
   and credit limits.
5. Deploy. Then check:
   * `https://your-domain/` — the shop loads
   * `https://your-domain/admin/` — you can log in and see orders
   * `https://your-domain/api/health` — shows `"ok": true` and `"b2b": {"enabled": false}`
   * Admin → Orders → open an order → **Print** works

If anything is wrong, redeploy the previous commit (see "Rolling back").

---

## Part 2 — Create the MySQL database

1. hPanel → **Databases → MySQL Databases** → create a database and a user
   with a strong generated password. Note the database name, user name and
   password. Hostinger prefixes both names with your account id
   (for example `u123456789_sohb2b`).
2. Create a **separate** database for testing if you want to try things
   first. Never point a development copy at the production database.
3. The host is normally `localhost` when the app and database are on the same
   plan (hPanel shows the exact host name).

## Part 3 — Environment variables

Add these in hPanel → your Node.js app → **Environment variables**.
Never put them in a file in the repository.

The complete list, with what is required and when, is `docs/unified/ENVIRONMENT.md`. That file is generated
from `src/config/env-schema.js`, and `.env.production.example` comes from the same schema.

- **Generate secrets** with `node scripts/generate-secrets.js`. It prints new random values and never stores them.
- **Check a configuration** before deploying: `node scripts/check-env.js --production --env-file=<file>`. It prints variable names only, never values.
- **Start-up check.** In production the app checks the whole configuration when it starts. If something required is missing or unsafe, it stops with a list of variable names. Fix those variables in hPanel and redeploy.
- **`ENCRYPTION_KEY`** protects stored secrets such as two-factor keys. It must be set when the business platform is on. Never change it once data is encrypted with it.

### Persistent folders (create them once, under your home folder, not under `domains/`)

| Variable | Example | Holds |
|---|---|---|
| `DATA_DIR` | `/home/u123456789/sakeofhealth-data` | the shop's orders, customers and products |
| `CATALOGUE_DIR` | `/home/u123456789/sakeofhealth-catalogue` | product snapshots and the protected-product change log |
| `BACKUP_DIR` | `/home/u123456789/sakeofhealth-backups` | the daily shop backups |
| `B2B_PRIVATE_DIR` | `/home/u123456789/sakeofhealth-private` | business documents (KYC, supplier, manufacturing, delivery photos) and import files |

Business documents can instead be kept in an S3-compatible bucket, such as Cloudflare R2, Backblaze B2 or AWS S3.
Set `STORAGE_PROVIDER=s3` and the `STORAGE_*` variables; see Part 7.

| Variable | Value |
|---|---|
| `DB_HOST` | `localhost` (or the host hPanel shows) |
| `DB_PORT` | `3306` |
| `DB_NAME` | the database name |
| `DB_USER` | the database user |
| `DB_PASSWORD` | the database password |
| `B2B_JWT_SECRET` | a long random string — see below |
| `B2B_PRIVATE_DIR` | an absolute path **outside** the site folder, e.g. `/home/u123456789/sakeofhealth-private` |
| `PUBLIC_SITE_URL` | `https://www.your-domain.com` |
| `OWNER_EMAIL` | who is told about new registrations |
| `NODE_ENV` | `production` |
| `B2B_ENABLED` | leave `false` for now |

Generate the secret on any computer with Node.js:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

In production the business portal refuses all logins until this secret is set,
at least 48 characters long, and different from `ADMIN_JWT_SECRET` and
`CUSTOMER_JWT_SECRET` (the command above gives 96 characters). It is never
derived from another secret in production.

`B2B_PRIVATE_DIR` holds GST certificates and shop documents. It must not be
inside `public_html` or the app folder: files there could be reachable from
the web and would be wiped by a redeploy.

## Part 4 — Create the tables

Tables are **not** created automatically on deploy. Choose one way:

**A. From the admin panel (no terminal needed)**

1. Set `B2B_ENABLED=true` and redeploy.
2. Log in to `/admin/` as an admin → **B2B Settings → System**.
3. It shows the database status and pending migrations. Press
   **Run migrations**.

**B. From a terminal** (hPanel → Advanced → SSH access)

```bash
cd ~/path-to-your-app
npm run migrate:status    # what will run
npm run migrate           # create / update the tables
npm run migrate:verify    # confirms every table exists
```

Migrations only ever add things. They refuse `DROP TABLE`, `DROP DATABASE`
and `TRUNCATE`, and can be run again safely.

## Part 5 — Switch on and check

1. `B2B_ENABLED=true`, redeploy (if not already done in Part 4).
2. `https://your-domain/api/health` → `"b2b": {"enabled": true, "database": "up"}`
3. Admin → **B2B Settings**:
   * **Company & invoices** — legal name, GSTIN, address, state, bank details.
     These print on every invoice, so fill them in before the first order.
   * **Service states** — the states you deliver to.
   * **Order rules** — first-order approval, minimum order value, returns.
4. Admin → **B2B Catalogue** → *Sync from store* (copies your shop products)
   or *Excel import* (template: `docs/samples/product-import-template.xlsx`).
5. Admin → **Pricing & Margins** — set the default margins.
6. Admin → **Inventory** → enter opening stock.
7. Register a test retailer at `https://your-domain/b2b/register`, approve it
   in Admin → Business Users, place an order, print the label.

## Turning B2B off again

Set `B2B_ENABLED=false` and redeploy. The business portal and its admin pages
disappear; the customer site is untouched; the MySQL data stays where it is.

---

## Part 6 — Background jobs (Hostinger Cron Jobs)

Set `JOBS_MODE=cron` (the production default). In hPanel → Advanced → **Cron Jobs**, add one custom job,
**every 5 minutes**, with the command on one line:

```
/opt/alt/alt-nodejs22/root/bin/node --env-file=/home/u123456789/domains/YOURDOMAIN/hbuilds/config/.env /home/u123456789/domains/YOURDOMAIN/hbuilds/current/nodejs/scripts/cron/run-jobs.js
```

The command has these limits:

- at most 255 characters;
- no `%` sign;
- the schedule runs in UTC;
- Hostinger stops a cron job after 30 minutes.

The Node binary path above is the usual one for Node 22. Use the exact path hPanel shows for your app's Node version.

Each run does the following, then exits:

- snapshots and backs up the shop catalogue;
- checks the four protected products;
- queues and runs the due business jobs;
- sends due messages;
- records itself.

Admin → ERP → Overview shows the last run, and warns when there has been no run for 30 minutes.
Details: `docs/unified/BACKGROUND-JOBS.md`.

## Part 7 — Business documents in a bucket (optional)

On Hostinger the private folder (`B2B_PRIVATE_DIR`) is persistent and enough. A bucket is useful for an
off-server copy, or when you move to several servers.

1. Create a **private** bucket and an access key that can only read and write that bucket.
2. Set these variables:
   - `STORAGE_PROVIDER=s3`
   - `STORAGE_ENDPOINT`, for example `https://<account>.r2.cloudflarestorage.com`
   - `STORAGE_BUCKET`, `STORAGE_REGION` (`auto` for R2)
   - `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`
3. Copy the existing documents: `node scripts/storage-copy.js` (dry run), then `node scripts/storage-copy.js --yes`.
   Local files are never deleted. Until they are copied, documents are still read from the folder.
4. Switch **versioning** on for the bucket. The nightly `npm run backup` copies the private folder, not the bucket.

Requests are signed with AWS Signature V4, built into the app. It is checked against AWS's published example
values, and no extra package is needed.

## Moving to a VPS or Cloud plan later

Nothing in the code is tied to Business hosting.

- **Process and jobs.** Run the same app with a process manager (pm2 or systemd). Either keep the cron job, run it every minute from the system crontab, or set `JOBS_MODE=inprocess`.
- **Data.** Point `DB_HOST` at the new MySQL server after a dump and restore (`docs/BACKUP-RESTORE.md`). Copy the four persistent folders, or use a bucket for documents.

## GitHub

```bash
git add -A
git commit -m "Add B2B retailer & distributor platform"
git push origin main
```

Before every push, check that no secret is included:

```bash
git status            # .env must NOT be listed
npm run build         # also fails if .env is tracked by git
```

`.gitignore` already excludes `.env`, data files, uploads, backups, keys and
SQL dumps. If a secret was ever committed, removing the file is not enough —
change that password or key.

Work on a branch and merge to `main` when tested; Hostinger deploys what is on
the branch you connected.

## Rolling back

Code and data roll back separately.

* **Code** — in GitHub, revert the commit and push, so that Hostinger deploys the previous code again.
  Hostinger has no per-commit rollback button. The previous version ignores tables it does not know about, so
  database changes do not need to be undone. Data folders are outside `hbuilds/`, so a redeploy never touches them.
* **Fastest safe switch** — set `B2B_ENABLED=false`.
* **Data** — only if data itself was damaged: restore from a backup. See
  `docs/BACKUP-RESTORE.md`.

Migrations are forward-only on purpose. If a migration needs undoing, write a
new migration that makes the correction, and test it on a copy first.

## Routine

| When | Do |
|---|---|
| Before every deploy that includes a new file in `src/db/migrations/` | `npm run backup`, then deploy, then run migrations |
| Every 5 minutes | the background cron job (Part 6). It also takes the daily shop-catalogue backup. |
| Daily | `npm run backup` (hPanel → Advanced → Cron Jobs: `/opt/alt/alt-nodejs22/root/bin/node --env-file=…/hbuilds/config/.env …/hbuilds/current/nodejs/scripts/backup.js`) and Hostinger's own database backups |
| After deploy | open `/api/health`, log in to the admin, open one order |
