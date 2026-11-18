# Backup, restore and rollback

There are three things to protect:

| What | Where it lives |
|---|---|
| Customer website data (orders, products, customers…) | JSON files in `DATA_DIR` (default `~/sakeofhealth-data`) |
| Business platform data | MySQL tables starting with `b2b_` |
| Uploaded business documents | `B2B_PRIVATE_DIR` (default `~/sakeofhealth-private`) |

## Taking a backup

```bash
npm run backup            # make one
npm run backup -- list    # see what exists
```

This writes a folder `backup-YYYYMMDD-HHMMSS` into `BACKUP_DIR`
(default `~/sakeofhealth-backups`, outside the site folder) containing:

```
b2c-data/*.json           the customer website's data
b2b-database.sql.gz       every b2b_ table — structure and rows
private-files/            uploaded documents and import files
manifest.json             row counts, for checking
```

* Pure Node.js — it does not need `mysqldump`, so it works on shared hosting.
* It only reads. The database part is taken as one consistent snapshot
  without locking the live site.
* The newest 14 backups are kept (`BACKUP_KEEP`).

**Schedule it.** hPanel → Advanced → Cron Jobs, once a day, for example:

```
cd /home/u123456789/path-to-app && /usr/bin/node scripts/backup.js >> ~/backup.log 2>&1
```

**Keep a copy somewhere else.** A backup on the same server does not protect
against losing the server or the account. Download the newest folder
regularly, and keep Hostinger's own automatic backups switched on as a second
line of defence.

A backup contains customer and business data and documents. Treat it like the
live data: do not email it, and do not put it in the Git repository.

## Checking a backup is good

`manifest.json` lists the number of rows saved per table. The surest check is
a test restore into an empty scratch database (below) and opening a few
records. Do this once after setting backups up, and again every few months.

## Restoring

Restoring replaces data, so it is deliberately manual. Stop and think before
each step; take a fresh backup of the current state first, even if it is
broken.

### Business platform (MySQL)

Restore into an **empty** database — never on top of live tables.

1. hPanel → Databases → create a new empty database and user.
2. Import `b2b-database.sql.gz`: hPanel → phpMyAdmin → select the new
   database → **Import** (it accepts `.sql.gz`), or from SSH:

   ```bash
   gunzip -c b2b-database.sql.gz | mysql -h HOST -u USER -p NEW_DATABASE
   ```

3. Point the app at it: change `DB_NAME` / `DB_USER` / `DB_PASSWORD` in the
   environment variables and redeploy.
4. Run `npm run migrate:verify`, then check a few orders and invoices.
5. Keep the old database until you are sure. Remove it yourself, later.

### Uploaded documents

Copy `private-files/` back into `B2B_PRIVATE_DIR`, keeping the folder
structure.

### Customer website

Stop the app, copy `b2c-data/*.json` back into `DATA_DIR`, start the app.

## Rolling back a deploy

See `docs/DEPLOYMENT-HOSTINGER.md` → Rolling back. In short: revert the code;
the database does not need to move backwards. Use a data restore only when
data was actually damaged.

## What the application will never do on its own

* run `DROP DATABASE`, `DROP TABLE` or `TRUNCATE`
* run migrations on deploy (unless you set `DB_AUTO_MIGRATE=true`)
* delete audit log entries, invoices or uploaded documents
* delete backups other than its own oldest ones beyond `BACKUP_KEEP`
