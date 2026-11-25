-- D5 inventory — READ-ONLY. Run by the server owner (root) in the mysql client.
-- Reads table NAMES and COUNTS from information_schema only; no table contents.
-- Lists every database that contains this project's tables (b2b_*), whether it
-- has the migration-history table, and how many of the 5 ERP core tables exist.
SELECT TABLE_SCHEMA AS db,
       COUNT(*) AS project_tables,
       SUM(TABLE_NAME = 'b2b_schema_migrations') AS has_migration_table,
       SUM(TABLE_NAME IN ('b2b_staff','b2b_roles','b2b_permissions','b2b_approval_requests','b2b_jobs')) AS erp_core_tables
FROM information_schema.TABLES
WHERE TABLE_NAME LIKE 'b2b!_%' ESCAPE '!'
GROUP BY TABLE_SCHEMA
ORDER BY TABLE_SCHEMA;
