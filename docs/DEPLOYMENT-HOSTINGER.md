# Deploying to Hostinger from GitHub

The site is one Node.js app. Hostinger pulls it from GitHub, runs
`npm install`, `npm run build`, then `npm start`.

Nothing here needs Docker, Redis, a queue server or compiled native modules.

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

* **Code** — in GitHub, revert the commit (or in hPanel redeploy the previous
  commit). The previous version ignores tables it does not know about, so
  database changes do not need to be undone.
* **Fastest safe switch** — set `B2B_ENABLED=false`.
* **Data** — only if data itself was damaged: restore from a backup. See
  `docs/BACKUP-RESTORE.md`.

Migrations are forward-only on purpose. If a migration needs undoing, write a
new migration that makes the correction, and test it on a copy first.

## Routine

| When | Do |
|---|---|
| Before every deploy that includes a new file in `src/db/migrations/` | `npm run backup`, then deploy, then run migrations |
| Daily | `npm run backup` (hPanel → Advanced → Cron Jobs) and Hostinger's own database backups |
| After deploy | open `/api/health`, log in to the admin, open one order |
