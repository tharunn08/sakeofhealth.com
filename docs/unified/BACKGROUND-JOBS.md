# Background jobs on Hostinger Business

Hostinger Business runs the site as one Node.js app that is started on demand and stopped when idle.
It has no always-running worker, no Redis and no custom ports. So background work runs from **Hostinger
Cron Jobs**: a short, finite Node.js script starts, does the due work, records what it did and exits.

## How it works

| Piece | File | What it does |
|---|---|---|
| Mode | `src/platform/jobs-config.js` | `JOBS_MODE=cron` (production default) or `inprocess` (development default). |
| Queue | `b2b_jobs` (migration 004, existing) · `src/modules/erp/core/jobs.js` | MySQL table. A run claims jobs atomically with a unique marker, so two runs never take the same job. A failed job retries after 4, 16 … minutes, then becomes `failed` and raises a monitoring event. A job left `running` by a stopped run is released after 30 minutes. |
| Schedule | `src/modules/erp/core/schedule.js` | The single list of recurring jobs (see below). Each run queues every job whose time slot has started and has no job yet. It reads the last job of each type and holds a MySQL named lock while it does so. A restart, a redeploy or a second run in the same slot therefore queues nothing new. |
| Run | `src/platform/cron.js` | One finite run, made of three steps (see the next table). |
| Cron script | `scripts/cron/run-jobs.js` | What Hostinger runs. Exits with 0 when everything went well, 1 when a step had a problem, and 78 when the configuration is unsafe. |
| HTTP trigger | `POST /api/internal/cron/run` | Use this only with an outside cron service that can call nothing but a URL. Send the header `X-Cron-Secret: <CRON_SECRET>`. Without `CRON_SECRET` the URL answers 404. The run is capped at 90 seconds, because Hostinger stops a request after 120 seconds. |

A run has three steps:

| Step | Needs | What it does |
|---|---|---|
| 1. Shop catalogue | Files only (works without MySQL) | Takes a snapshot of the products file when it has changed, makes the daily backup and checks the four protected products. A damaged catalogue is never snapshotted: the last good snapshot stays as the restore point. |
| 2. Business platform | MySQL | Lets only one run work at a time (a second run exits at once), then: queues the due recurring jobs; runs jobs until none are due, `JOB_BATCH_SIZE` have been claimed or `JOB_TIME_BUDGET_SECONDS` have passed; and sends the messages due in the notification outbox, under the outbox's own consent and provider rate limits. |
| 3. Record | ERP database (migration 004 applied) | Writes one `b2b_jobs` row with `job_type = 'cron.run'`, holding the run's summary. |

Messages created while a visitor uses the site — order codes, approvals, notices — are not left waiting
for the next cron run. When the transaction that queued a message commits, the web process hands it to the
provider. If that attempt fails, the row stays queued and the next cron run retries it.

### Recurring jobs

| Every | Job |
|---|---|
| 1 minute | `shopstock.sync`: shop stock catch-up. It does nothing while the stock mode is off. |
| 10 minutes | `shopstock.auto_refunds` · `catalog.publish_due` · `sales.expire_holds` · `b2c.feed` (only when switched on) · `deliveries.sync` · `deliveries.alert_late` |
| Daily (00:00 UTC) | `audit.verify` · `inventory.reconcile` · `notifications.stock_alerts` · `customers.import` (only when switched on) · `inventory.expire_batches` · `jobs.cleanup` (removes finished jobs after 30 days and failed ones after 90 days) |

A 1-minute job runs only as often as cron runs. With a 5-minute cron, it runs every 5 minutes.

### What still runs inside the web process with `JOBS_MODE=cron`

Two cheap refreshes run only while the process is alive. Each stops when Hostinger idles the app.

- **Shop stock mode.** It is re-read every minute (`shopstock/front.js`). This keeps the fail-closed rule current.
- **Products file.** A snapshot is taken when the file changes, checked every minute (`catalogueGuard.watch`).

The ERP job worker, the scheduler and the trade-portal message timer are **not** started.

## Setting it up in hPanel

1. **Environment variables.** Set these in hPanel → your Node.js app → Environment variables, next to the others:

   - `JOBS_MODE=cron`. This is the default in production; setting it explicitly is clearer.
   - `CRON_SECRET`: only for the HTTP trigger. Generate it with `node scripts/generate-secrets.js`.
   - `JOB_BATCH_SIZE` (default 50) and `JOB_TIME_BUDGET_SECONDS` (default 240): optional.

2. **Create the cron job.** Go to hPanel → Advanced → **Cron Jobs**, choose a custom schedule, and set it to every 5 minutes (`*/5 * * * *`). Use a one-line command:

   ```
   /opt/alt/alt-nodejs22/root/bin/node --env-file=/home/uXXXXXXX/domains/YOURDOMAIN/hbuilds/config/.env /home/uXXXXXXX/domains/YOURDOMAIN/hbuilds/current/nodejs/scripts/cron/run-jobs.js
   ```

   Replace `uXXXXXXX` and `YOURDOMAIN` with your own values. Then check these points:

   - **Node path.** Copy the binary path from hPanel for the Node version your app uses. `alt-nodejs20` is the path in Hostinger's own example; for Node 22 it is normally `alt-nodejs22`.
   - **Node version.** `--env-file` needs Node 20.6 or newer.
   - **Command format.** Hostinger allows at most 255 characters and no `%` sign.
   - **Time zone.** Cron times are UTC.
   - **Time limit.** Hostinger stops a cron job after 30 minutes. A run stops claiming new work after `JOB_TIME_BUDGET_SECONDS`, well before that.

3. **Check the first runs.**

   - In hPanel, open the cron job's output. Each run prints one line starting with `[cron]`.
   - In Admin → ERP → Monitoring, look under "Background jobs". It shows the last `cron.run` and warns when no run has been recorded for 30 minutes.
   - To see the full summary yourself: `node scripts/cron/run-jobs.js --json`, run in the app folder from the hPanel terminal or SSH.

## Local development

`npm run dev` uses `JOBS_MODE=inprocess`, so timers in the web process do the work. To try the cron path
locally, set `JOBS_MODE=cron` in `.env`, start the site, and run `node scripts/cron/run-jobs.js`.

## Moving to a VPS or Cloud plan later

On a VPS the same script can run from the system crontab every minute. You can also set
`JOBS_MODE=inprocess` and run the app under a process manager (pm2 or systemd). Either way it uses the same
queue, schedule and handlers, so nothing else changes.

## Verification status

- **Database-free tests (pass):** `tests/jobs-cron.test.js`. They cover the mode defaults, the budgets, the slot arithmetic and the idempotency rules, the finite runner's stop conditions, which timers each mode starts, and the cron script end to end on the shop catalogue (including a damaged protected product and an unsafe production configuration). They also test the HTTP trigger: 404 when it is off, 403 for a wrong secret, and a summary with the right one.
- **MySQL tests (written, NOT RUN here because no MySQL 8 server was available):** `tests/jobs-cron.mysql.test.js`. They cover two schedulers at the same moment, no re-queue after a restart, the batch size, the run lock, the `cron.run` record and the monitoring view, cleanup, sending after commit but never after a rollback, and the script against the test database. Run them with `node scripts/run-all-tests.js --mysql`.
