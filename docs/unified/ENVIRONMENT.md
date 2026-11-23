# Environment variables

Generated from `src/config/env-schema.js` by `node scripts/env-templates.js` — do not edit by hand. The server checks all of them at start-up (`src/config/env.js`); in production a missing or unsafe value stops the start with a list of what to fix. Check a configuration without starting: `npm run check:env`.

Templates: `.env.example` (all), `.env.development.example` (local), `.env.production.example` (Hostinger). Secrets are never printed or logged.

## Application

| Variable | Needed | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | required | enum | — | production on the live site. Production turns on every safety check below. |
| `PORT` | optional | int | `3000` | Port to listen on. Hostinger sets it for you — leave it empty there. |
| `SITE_URL` | required in production | url | — | Address of the online shop, used in order e-mails and payment links. |
| `PUBLIC_SITE_URL` | required when B2B_ENABLED=true | url | — | Public address used in trade-portal e-mails, unsubscribe links, invoice links and printed labels (falls back to SITE_URL). |
| `CONFIG_STRICT` | optional | bool | `true in production` | When true (the production default) the server refuses to start while any variable below is missing or invalid. false = start anyway and log every problem — emergencies only. |
| `BRAND_NAME` | optional | string | `Sake of Health` | Name shown in e-mails, invoices and the admin. |

## Shop admin and customer sign-in

| Variable | Needed | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| `ADMIN_EMAIL` | required in production | email | — | Root shop administrator sign-in e-mail. |
| `ADMIN_PASSWORD` | required in production | secret (secret), 12+ chars | — | Root shop administrator password (12+ characters). Change it after the first sign-in. |
| `ADMIN_JWT_SECRET` | required in production | secret (secret), 32+ chars (48+ in production) | — | Signs shop-admin sessions. Without it admin sign-in is switched off. Changing it signs every admin out. |
| `ADMIN_SESSION_HOURS` | optional | int | `12` | Admin session length in hours. |
| `CUSTOMER_JWT_SECRET` | required in production | secret (secret), 32+ chars (48+ in production) | — | Signs customer sessions on the shop. Without it customer accounts are switched off. |
| `CUSTOMER_SESSION_DAYS` | optional | int | `30` | Customer session length in days. |
| `JWT_SECRET` | optional | secret (secret) | — | Old name of B2B_JWT_SECRET. Do not set it on new installations. **Deprecated:** Use B2B_JWT_SECRET. Kept only as a fallback for old installations. |

## Shop data, protected products and backups

| Variable | Needed | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| `DATA_DIR` | required in production | path | `~/sakeofhealth-data` | Shop data folder (orders, products, customers…). In production an ABSOLUTE path OUTSIDE the site folder — on Hostinger under /home/<user>/, never inside domains/<domain>/hbuilds or public_html, which every deploy overwrites. |
| `CATALOGUE_DIR` | required in production | path | `~/sakeofhealth-catalogue` | Product snapshots and the protected-products change log, outside the site folder. |
| `BACKUP_DIR` | required in production | path | `~/sakeofhealth-backups` | Daily and manual backups (npm run backup), outside the site folder. |
| `BACKUP_KEEP` | optional | int | `14` | How many manual backups to keep. |
| `PROTECTED_PRODUCTS_STRICT` | optional | bool | `true in production` | When true (the production default) the server will not start if the four protected products fail the integrity check. Set false only to start in an emergency; /api/health then shows protectedProducts:false. |
| `AUTO_SEED` | optional | bool | `true` | Development only: fill an empty shop with the demo catalogue. Ignored in production (no demo data there). |
| `SEED_DEMO_DATA` | optional | bool | `false` | Development only: add demo orders and reviews too. |

## Shop settings

| Variable | Needed | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| `SHIPPING_FEE` | optional | int | `49` | Shipping charge in rupees. |
| `FREE_SHIPPING_ABOVE` | optional | int | `499` | Order value from which shipping is free. |
| `DELIVERY_DAYS` | optional | int | `4` | Promised delivery time shown to customers. |
| `ORDER_PREFIX` | optional | string | `SOH` | Prefix of order numbers. |
| `SUPPORT_EMAIL` | optional | email | — | Support address shown to customers. |
| `SUPPORT_PHONE` | optional | string | — | Support phone shown to customers. |
| `DEFAULT_COUNTRY_CODE` | optional | int | `91` | Country code added to 10-digit mobile numbers. |
| `B2C_MAX_LINE_QTY` | optional | int | `20` | Most units of one product in one online order. |

## Payments (Razorpay)

| Variable | Needed | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| `PAYMENT_MOCK` | optional | bool | `false` | Development only: orders complete without a real payment. Ignored (and reported) in production. |
| `RAZORPAY_KEY_ID` | required in production | string | — | Razorpay key id (rzp_live_… on the live site, rzp_test_… anywhere else). |
| `RAZORPAY_KEY_SECRET` | required when RAZORPAY_KEY_ID is set | secret (secret) | — | Razorpay key secret, from the same dashboard page as the key id. |
| `RAZORPAY_WEBHOOK_SECRET` | optional | secret (secret) | — | Razorpay webhook secret (Settings → Webhooks); needed for webhooks at /api/b2b/webhooks/razorpay and the shop webhook. |
| `RAZORPAY_API_BASE` | optional (tests only) | url | — | Tests only: points payments at a fake Razorpay. Never set it on a real site. |

## E-mail (SMTP)

| Variable | Needed | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| `SMTP_HOST` | optional | string | — | SMTP server. Empty = no e-mail is sent (messages are recorded as "not sent"). |
| `SMTP_PORT` | optional | int | `587` | SMTP port (465 with SMTP_SECURE=true, 587 otherwise). |
| `SMTP_SECURE` | optional | bool | `false` | true for port 465 (TLS from the start). |
| `SMTP_USER` | required when SMTP_HOST is set | string | — | SMTP user name (usually the full mailbox address). |
| `SMTP_PASS` | required when SMTP_HOST is set | secret (secret) | — | SMTP password (for Gmail an App Password). |
| `SMTP_FROM` | required when SMTP_HOST is set | string | — | From address of every e-mail. |
| `OWNER_EMAIL` | optional | csv | — | Who is told about new trade registrations and orders needing approval (comma separated). |

## WhatsApp

| Variable | Needed | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| `WHATSAPP_TOKEN` | optional | secret (secret) | — | Meta WhatsApp Cloud API access token. Empty = no WhatsApp messages. |
| `WHATSAPP_PHONE_NUMBER_ID` | required when WHATSAPP_TOKEN is set | string | — | Meta WhatsApp phone number id. |
| `WHATSAPP_APP_SECRET` | optional | secret (secret) | — | Meta app secret: checks delivery reports and STOP/START replies at /api/webhooks/whatsapp. |
| `WHATSAPP_VERIFY_TOKEN` | required when WHATSAPP_APP_SECRET is set | secret (secret) | — | Any random string; enter the same value in Meta when you register the webhook. |
| `WHATSAPP_ORDER_TEMPLATE` | optional | string | — | Approved Meta template for order confirmations. |
| `WHATSAPP_STATUS_TEMPLATE` | optional | string | — | Approved Meta template for order status updates. |
| `WHATSAPP_TEMPLATE_LANG` | optional | string | `en_US` | Language code of the templates. |
| `WHATSAPP_TEMPLATE_EVENT_INVOICE` | optional | string | — | Approved template for event counter invoices (one parameter: the invoice link). |
| `WHATSAPP_TEMPLATE_<NAME>` | optional | string | — | Maps a logical message name (e.g. WHATSAPP_TEMPLATE_WHATSAPP_OTP) to its approved Meta template name. |
| `TWILIO_ACCOUNT_SID` | optional | string | — | Alternative to Meta: Twilio WhatsApp account SID. |
| `TWILIO_AUTH_TOKEN` | required when TWILIO_ACCOUNT_SID is set | secret (secret) | — | Twilio auth token. |
| `TWILIO_WHATSAPP_FROM` | required when TWILIO_ACCOUNT_SID is set | string | — | Twilio WhatsApp sender number. |

## SMS (MSG91)

| Variable | Needed | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| `MSG91_AUTH_KEY` | optional | secret (secret) | — | MSG91 auth key (DLT-registered templates only). Empty = no SMS. |
| `MSG91_WEBHOOK_TOKEN` | optional | secret (secret) | — | Token in the MSG91 delivery-report URL /api/webhooks/msg91?token=… |
| `MSG91_TEMPLATE_<NAME>` | optional | string | — | MSG91 template id per logical message name, e.g. MSG91_TEMPLATE_ORDER_OTP. |
| `MSG91_BASE_URL` | optional (tests only) | url | — | Tests only: points SMS at a fake MSG91. |

## Maps and analytics

| Variable | Needed | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| `GOOGLE_MAPS_API_KEY` | optional | secret | — | Google Maps key for address lookup; empty = free OpenStreetMap. |
| `META_PIXEL_ID` | optional | string | — | Meta pixel id. |
| `META_ACCESS_TOKEN` | optional | secret (secret) | — | Meta Conversions API token. |
| `META_TEST_CODE` | optional | string | — | Meta test event code (testing only). |
| `GA4_MEASUREMENT_ID` | optional | string | — | Google Analytics 4 measurement id. |
| `GA4_API_SECRET` | optional | secret (secret) | — | GA4 Measurement Protocol secret. |

## Business database (MySQL)

| Variable | Needed | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| `B2B_ENABLED` | optional | bool | `false` | Turns on the trade portal and the business database. Keep false until the database is created, backed up and migrated. |
| `DB_HOST` | required when B2B_ENABLED=true | string | — | MySQL host (Hostinger: usually localhost). |
| `DB_PORT` | optional | int | `3306` | MySQL port. |
| `DB_USER` | required when B2B_ENABLED=true | string | — | MySQL user (hPanel → Databases). |
| `DB_PASSWORD` | required when B2B_ENABLED=true | secret (secret) | — | MySQL password. |
| `DB_NAME` | required when B2B_ENABLED=true | string | — | MySQL database name. Use a separate database for development and a throw-away one for tests. |
| `DB_POOL_SIZE` | optional | int | `6` | Connections in the pool. Shared hosting: keep 4–8 (each connection counts against the MySQL user limit). |
| `DB_AUTO_MIGRATE` | optional | bool | `false` | Run migrations at start. Keep false in production: take a backup and run npm run migrate yourself. |
| `ALLOW_DESTRUCTIVE_MIGRATIONS` | optional | bool | `false` | Only together with a reviewed "-- allow-destructive" migration. Never leave true. |

## Trade portal (retailers and distributors)

| Variable | Needed | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| `B2B_JWT_SECRET` | required when B2B_ENABLED=true | secret (secret), 32+ chars (48+ in production) | — | Signs retailer and distributor sessions; different from every other secret. |
| `B2B_SESSION_HOURS` | optional | int | `72` | Trade-portal session length. |
| `B2B_PRIVATE_DIR` | required when B2B_ENABLED=true in production | path | `~/sakeofhealth-private` | Private documents (KYC, supplier documents, import files) — absolute path outside the site folder; never served to the web. |
| `B2B_MAX_UPLOAD_MB` | optional | int | `5` | Largest upload. |
| `B2B_MAX_IMPORT_MB` | optional | int | `15` | Largest Excel import. |
| `B2B_RATE_PER_MIN` | optional | int | `400` | Requests per minute per trade-portal user. |
| `B2B_ADMIN_RATE_PER_MIN` | optional | int | `600` | Requests per minute per staff user on trade admin APIs. |
| `B2B_NOTIFY_INTERVAL_SECONDS` | optional | int | `30` | How often the in-process notification sender runs (JOBS_MODE=inprocess only). |

## Back office (business platform)

| Variable | Needed | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| `ERP_ENABLED` | optional | bool | `false` | Turns on the business platform (needs B2B_ENABLED=true too). |
| `ERP_JWT_SECRET` | required when B2B_ENABLED=true and ERP_ENABLED=true | secret (secret), 32+ chars (48+ in production) | — | Signs business-staff sessions, unsubscribe and invoice links; 48+ characters in production, different from every other secret. |
| `ENCRYPTION_KEY` | optional | secret (secret), 32+ chars | — | Encrypts 2FA secrets and bank account numbers (AES-256-GCM). Set it before the first bank account or 2FA is saved and NEVER change or lose it — data encrypted with it cannot be read without it. Keep a copy in your password manager. Without it the older key derived from ERP_JWT_SECRET is used (then ERP_JWT_SECRET must never change). |
| `ERP_SESSION_HOURS` | optional | int | `8` | Business-staff session length. |
| `ERP_IDLE_MINUTES` | optional | int | `60` | Signed out after this many idle minutes. |
| `ERP_WORKER_INTERVAL_MS` | optional | int | `30000` | In-process job timer (JOBS_MODE=inprocess only). |
| `ERP_ADMIN_PASSWORD` | optional (only for scripts/erp-create-admin.js) | secret (secret) | — | Only for the one-off command that creates the first business admin; never stored in .env. |

## File storage (uploads, invoices, documents)

| Variable | Needed | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| `STORAGE_PROVIDER` | optional | enum | `local` | Where uploaded business files (trade KYC documents, supplier documents, manufacturing documents, proof-of-delivery photos) are kept: local = B2B_PRIVATE_DIR on this server, s3 = an S3-compatible service (Cloudflare R2, Backblaze B2, AWS S3). Shop product images are part of the site, not uploads. |
| `STORAGE_ENDPOINT` | required when STORAGE_PROVIDER=s3 | url | — | S3 endpoint, e.g. https://<account>.r2.cloudflarestorage.com or https://s3.<region>.backblazeb2.com. |
| `STORAGE_BUCKET` | required when STORAGE_PROVIDER=s3 | string | — | Bucket name (private bucket). |
| `STORAGE_REGION` | optional | string | `auto` | Region (R2: auto; B2/AWS: the bucket region). |
| `STORAGE_ACCESS_KEY` | required when STORAGE_PROVIDER=s3 | secret (secret) | — | Access key id with read/write on that bucket only. |
| `STORAGE_SECRET_KEY` | required when STORAGE_PROVIDER=s3 | secret (secret) | — | Secret access key. |

## Scheduled jobs (Hostinger Cron Jobs)

| Variable | Needed | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| `JOBS_MODE` | optional | enum | `inprocess (cron in production)` | cron = background work runs only from Hostinger Cron Jobs (scripts/cron/run-jobs.js), as Business hosting requires; inprocess = timers inside the web process (development). |
| `CRON_SECRET` | optional | secret (secret), 32+ chars | — | Lets a cron job call POST /api/internal/cron/run with the header X-Cron-Secret instead of running the script. Empty = that URL is switched off. |
| `JOB_BATCH_SIZE` | optional | int | `50` | Most jobs one cron run claims. |
| `JOB_TIME_BUDGET_SECONDS` | optional | int | `240` | A cron run stops claiming new jobs after this many seconds (Hostinger stops a cron job after 30 minutes and an HTTP request after 120 s; the HTTP trigger caps it at 90 s). |

## Used only by developer tools

| Variable | Used by |
| --- | --- |
| `TEST_DB_HOST` | Throw-away MySQL test database for RUN-ALL-TESTS --mysql (with TEST_DB_PORT, TEST_DB_USER, TEST_DB_PASSWORD, TEST_DB_NAME). |
| `TEST_DB_PORT` | See TEST_DB_HOST. |
| `TEST_DB_USER` | See TEST_DB_HOST. |
| `TEST_DB_PASSWORD` | See TEST_DB_HOST. |
| `TEST_DB_NAME` | See TEST_DB_HOST. |
| `D5_HOST` | scripts/d5-inspect.js (read-only inspection, with D5_PORT, D5_USER, D5_PASSWORD). |
| `D5_PORT` | See D5_HOST. |
| `D5_USER` | See D5_HOST. |
| `D5_PASSWORD` | See D5_HOST. |
| `CREDENTIALS_DIR` | scripts/seed-accounts.js: where first-login credentials are written (outside the project). |
| `USERNAME` | Set by Windows itself; read by scripts/seed-accounts.js to restrict the credentials file to you. |
| `DEBUG` | scripts/seed-b2b-dev.js prints full errors when set. |

## Not used by this application

These appear in generic checklists but nothing in the code reads them, so they are deliberately not configured: `APP_URL`/`API_BASE_URL`/`FRONTEND_URL` (one app serves shop, API and portals at `SITE_URL`), `APP_TIMEZONE` (business days are computed in India time in code), `SESSION_SECRET`/`CSRF_SECRET`/`COOKIE_*` (sessions are signed bearer tokens per audience, not cookies), `ENCRYPTION_KEY` (bank account numbers are encrypted with a key derived from `ERP_JWT_SECRET` — see the security report), `PAYMENT_PROVIDER` (Razorpay only), `AI_*` (no AI integration), `ERROR_TRACKING_DSN`/`LOG_LEVEL` (logs go to the Hostinger app log), `CASHFREE_*`/`COD_ENABLED` (removed from the old template: never read by the code).
