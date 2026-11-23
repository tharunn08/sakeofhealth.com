# Performance report — 19 November 2026

## Shop (B2C): measured

**Method.** `node scripts/perf-b2c.js 1000 10000 30000`, run in throw-away folders.

- **Data.** Real orders were placed through the API first. They were then copied, with new ids, dates spread over 18 months and new customers, up to each volume. Customers number 60% of orders.
- **Calls.** Each endpoint was called 30 times one after another, then 60 times with 10 at once.
- **Visitors.** Every request came from its own simulated visitor, so the per-visitor rate limits did not distort the figures.
- **Machine.** Node 22, on this workspace's virtual machine. Hostinger Business may be slower.
- **Raw data.** `perf-b2c-2026-11-19.json`.

Times are p50 / p95 in milliseconds.

| Endpoint | 1,000 orders (1.2 MB file) | 10,000 orders (12.3 MB) | 30,000 orders (37 MB) | 30,000, 10 at once |
|---|---|---|---|---|
| Shop: product list | 2.5 / 5 | 2.4 / 5.4 | 2.5 / 4.9 | 12.7 / 14.6 |
| Shop: product page | 1.2 / 2.7 | 1.3 / 1.9 | 1.2 / 2.6 | 5.7 / 10.2 |
| Shop: track an order | 6.3 / 8.2 | 40.7 / 50.3 | 166.7 / 257 | 1,103 / 1,852 |
| Shop: **place an order** (write) | 21.6 / 32.2 | 205 / 255 | **755 / 809** | — |
| Admin: orders, page 1 | 7.1 / 10.9 | 47.7 / 59.3 | 190 / 250 | 1,848 / 2,135 |
| Admin: order search | 6 / 7.4 | 44.2 / 54.3 | 182 / 250 | 1,931 / 2,017 |
| Admin: customers (all; 8 MB at 30k) | 6.6 / 21.3 | 52.4 / 78.4 | 157 / 229 | 1,272 / 1,351 |
| Admin: dashboard | 9.7 / 15.3 | 85.9 / 111 | 266 / 365 | 2,562 / 2,638 |
| Admin: analytics | 16.4 / 18.8 | 170 / 193 | 574 / 737 | 5,509 / 5,863 |

### What this means

- **Browsing the shop stays fast at every volume.** The product list and product pages take a few milliseconds, because the products file is small.
- **Everything that reads orders grows in step with the orders file**, and so does placing an order. The shop stores data in JSON files and reads the whole file from disk on every request. It does not keep a copy in memory, because a copy could disagree with what another process wrote. Every change rewrites the whole file, safely: it writes a temporary file and renames it.
  - Up to about **10,000 orders** (about 30 a day for a year), every call stays well under a quarter of a second.
  - At **30,000 orders**, placing an order takes about 0.8 s, and the analytics page takes 0.6 s, or 5.5 s with 10 at once.
  - On the plan's shared CPU it may be slower.
- **One request at a time for writes.** Order writes are serialised by the single Node process, which also keeps them safe.

### Options (owner decision: they change protected shop files)

1. **A read cache keyed by file identity.** It would reuse the parsed file while its inode, size and modification time are unchanged. Another process's write changes these, so it stays safe across processes. It touches `src/services/db.js`, and callers must not change returned objects without saving them. Expect reads to drop to a few milliseconds; writes would still rewrite the file.
2. **Move shop orders and customers into MySQL**, which the business platform already uses. This is the long-term answer for large volumes, and it is a larger, separately approved change.
3. **Page the admin customer list** (QR-12). It is small, but the screen must change with it.

None of these was done in this phase. Your instruction was not to change live shop behaviour or protected files beyond what you asked.

## Business platform (MySQL): NOT MEASURED

`scripts/perf-seed.js` fills a disposable `*_test` database with 10,000 products, 1,000 distributors, 12,000 retailers and 100,000 orders. The queries already rely on:

- indexed, server-side paging and filters;
- short transactions, with retries on deadlock;
- pooled connections;
- stock positions kept up to date as each movement is recorded, never recomputed for every request.

These cannot be measured here without MySQL. Run the seed on the test database, then time the admin order list, reports and checkout. Record the results here.

## Background runs

Each cron run is bounded:

- **Batch:** at most `JOB_BATCH_SIZE` jobs (default 50).
- **Claiming:** it stops claiming new work after `JOB_TIME_BUDGET_SECONDS` (240 s; capped at 90 s for the HTTP trigger).
- **Overlap:** two runs never overlap, because they share a MySQL named lock.
- **Maintenance:** `jobs.cleanup` removes finished jobs after 30 days, in batches of 1,000 rows, so the job table does not grow without limit.
- **Measured without a database:** a run with only the shop steps took under 1 s.
