# Verifying on Dolt (when no MySQL 8 is at hand)

The build environment has no MySQL 8 server and cannot install one. The integration
suites were run against **Dolt 2.7.2** instead, which is a MySQL-compatible database
server that reports itself as `8.0.31`. **Dolt is not MySQL.** A green run on Dolt shows
that the SQL, the flows and the permission checks work. It does **not** replace a run on
MySQL 8, for two reasons:

- **Row locks:** Dolt accepts `SELECT … FOR UPDATE` but does not lock rows, so concurrency
  tests cannot pass on it.
- **Missing function:** Dolt has no `UTC_DATE()`. `dolt-shim.js` (test-only, never loaded
  by the application) rewrites it to `DATE(UTC_TIMESTAMP())` inside the test process.

```bash
dolt sql-server -H 127.0.0.1 -P 3306 &      # in an empty folder; create database sakeofhealth_test
NODE_OPTIONS="--require ./tools/verify-on-dolt/dolt-shim.js" \
  node --test --test-concurrency=1 tests/erp-*.test.js
```

## Known Dolt-only failures in the existing `tests/b2b-platform.test.js`

The concurrency tests were skipped. Of the remaining 47 tests, 37 pass. The same 10 fail
both **before and after** the ERP code was added, so the ERP code did not cause them:

- **Locking:** credit, payment-callback and cancel races. Dolt does not lock rows.
- **DECIMAL values:** returned as numbers instead of strings (the dashboards test).
- **Engine crash:** a planner panic on a `NaN` parameter (the SQL-injection test).
- **Follow-on failures:** tests that depend on the earlier failures.

Run the full suite on MySQL 8 for the real result.
