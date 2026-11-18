# Sake of Health — E-commerce Platform

A complete storefront and admin panel: orders, products, coupons, analytics, customers, reviews, staff, deliveries, location capture, order tracking, and email + WhatsApp notifications.

---

## What's new in 2.0 — business platform and printing

**Printing (always available).** Every order can be printed as a delivery
label to stick on the parcel (4 × 6 inch thermal or A4 four-up, with barcode,
QR code to the address, large pincode and phone, amount to collect) and as a
bill. Admin → Orders → open an order → **Print**, or **Print labels** for a
batch. See [docs/PRINTING.md](docs/PRINTING.md).

**B2B retailer & distributor platform (optional, off by default).** A separate
business portal at `/b2b` where retailers and distributors register, are
approved, see their own trade prices, order, and get GST invoices — plus a
**B2B / Business** section in the admin panel for approvals, the product
master, pricing and margins, Excel import, distributor network, inventory,
finance and reports.

* It is switched on with `B2B_ENABLED=true` and needs a MySQL database.
* With it off (the default) the customer website runs exactly as before and no
  database is contacted.
* The customer website's own data was not moved or changed.

| Read this | For |
|---|---|
| [docs/DEPLOYMENT-HOSTINGER.md](docs/DEPLOYMENT-HOSTINGER.md) | Step-by-step: GitHub → Hostinger, MySQL, environment variables, switching on, rolling back |
| [docs/B2B-ARCHITECTURE.md](docs/B2B-ARCHITECTURE.md) | How it works: pricing precedence, order flow, GST, roles, the decisions made |
| [docs/PRINTING.md](docs/PRINTING.md) | Labels and bills |
| [docs/BACKUP-RESTORE.md](docs/BACKUP-RESTORE.md) | Backups, restore, rollback |
| [docs/TESTING.md](docs/TESTING.md) | Automated tests, performance results, go-live checklist |
| [docs/samples/product-import-template.xlsx](docs/samples/product-import-template.xlsx) | Excel template for product / price / stock import |

### Commands

| Command | What it does |
|---|---|
| `npm install` | install dependencies |
| `npm run build` | pre-flight check (syntax, dependencies, migrations, no committed `.env`) — nothing is compiled |
| `npm start` | start the site |
| `npm run migrate` / `migrate:status` / `migrate:verify` | create or update the B2B tables — never drops anything |
| `npm run backup` | back up the customer data, the B2B database and uploaded documents |
| `npm test` | all automated tests (needs a test database) |
| `npm run test:b2c` | customer-site regression tests only |
| `npm run b2b:seed-dev` | demo retailers, distributors and orders — **development databases only** |

### Business portal URLs

| What | URL |
|---|---|
| Business login | `/b2b/login` |
| Business registration | `/b2b/register` |
| Admin → B2B | `/admin/b2b/dashboard.html` |
| Health check | `/api/health` |

---

## Quick Start

```bash
npm install
npm start
```

Then open:

| What | URL |
|---|---|
| Storefront | http://localhost:3000 |
| **Admin panel** | **http://localhost:3000/admin/** |
| Order tracking | http://localhost:3000/track.html |

**Admin login** (from your `.env`):

```
Email:    admin@sakeofhealth.com
Password: ChangeMe@2026
```

> Change `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env` before deploying anywhere public.

The database seeds itself on first run with your 4 real products, 1 upcoming product, 4 coupons, 4 staff accounts, ~68 demo orders spread over 45 days, and 7 reviews — so every dashboard and chart has data immediately.

---

## Payments are in TEST MODE

`PAYMENT_MOCK=true` in `.env`. Orders complete instantly without charging anything, and everything downstream (emails, WhatsApp, admin panel, tracking) behaves exactly as it will in production.

Payment is required online before an order is placed — there is no cash on delivery.

**To go live:**

1. Get your keys from https://dashboard.razorpay.com/app/keys
2. In `.env`:
   ```
   PAYMENT_MOCK=false
   RAZORPAY_KEY_ID=rzp_live_xxxxx
   RAZORPAY_KEY_SECRET=xxxxx
   ```
3. Restart the server.

Payment signatures are verified server-side, so a forged payment cannot create a paid order.

---

## Admin Panel

Eleven sections in the sidebar:

### Dashboard
Today's orders and revenue, yesterday's orders and revenue, percentage change between them, lifetime totals, a "needs action" counter, the order pipeline by status, and the ten most recent orders. Auto-refreshes every 60 seconds.

### Orders
Every order with filters for status and date range (today / yesterday / this week), plus search across order ID, customer name, phone and email. Click any row to open the detail drawer, which shows:

- Full customer contact details
- Complete delivery address including landmark
- **The GPS location the customer shared**, on an embedded map with a Google Maps link
- Itemised breakdown with coupon and totals
- Payment method, status and gateway payment ID
- Full status timeline showing who changed what and when
- **Status update buttons** — Accepted → Prepared → Out for Delivery → Delivered
- Cancel option, internal notes, and a resend-notification button

Every status change automatically emails and WhatsApps the customer.

### Products
Add, edit and delete products. Everything you add appears on the storefront immediately. Supports the **upcoming products** you asked for: tick "Upcoming", set a launch date, and it shows as "Coming Soon" with purchasing disabled. Also handles price, MRP, stock, category, SKU, images, highlights, badges and display order.

### Coupons
Create discount codes any time. Three types:

- **Percentage off** — with an optional maximum discount cap
- **Flat amount off**
- **Free delivery**

Each supports a minimum order value, total usage limit, start date and expiry date. Tick **"Show on storefront"** and the coupon appears automatically in the offers strip at checkout, where customers can tap to apply it. Leave it unticked and the code works only if typed manually.

### Analytics
Revenue and order charts over 7 / 30 / 90 days, top products by revenue, top cities, coupon performance, payment method split, repeat-customer rate, and average fulfilment time.

### Customers
Auto-built from orders. Search and sort by recency, spend or order count. Click through for lifetime value, full order history, last known address with a map link, and private notes.

### Reviews
Moderation queue. Approve, reject, reply publicly, or delete. Reviews from customers who actually bought and received the product are automatically flagged "Verified buyer". Only approved reviews show on the site.

### Staff
Add team members with their own logins and roles:

| Role | Access |
|---|---|
| `admin` | Everything |
| `manager` | Everything except deleting staff |
| `staff` | Orders, customers, reviews, deliveries |
| `delivery` | Assigned deliveries only |

Seeded accounts (change these):

```
manager@sakeofhealth.com / manager@1234
ravi@sakeofhealth.com    / delivery@1234
sunil@sakeofhealth.com   / delivery@1234
support@sakeofhealth.com / support@1234
```

### Deliveries
A three-column board — Accepted, Prepared, Out for Delivery — with one-tap status advancement. Assign orders to delivery agents; the agent gets a WhatsApp with the customer's address, a map link, the amount, and whether to collect cash. COD orders are clearly flagged.

### Reports
CSV exports that open in Excel, Google Sheets or Tally:

- **Orders** — every order with details, payment status, address and GPS, filterable by date range and status
- **Sales** — revenue-focused: subtotals, discounts, coupons, totals, payment references
- **Deliveries** — door number, full address, landmark, GPS map link and assigned agent
- **Customers** — contact details, order counts, lifetime value
- **Products** — stock levels, units sold, revenue

All date-based reports share a From/To range with quick presets (7/30/90 days, last year).

### Settings
Store details, live integration status (email / WhatsApp / Razorpay / Maps), and a test-notification tool to confirm your credentials work.

---

## Customer Features

### Share location & pick on map
At checkout, customers get two buttons:

- **Share my location** — uses GPS, reverse-geocodes it, and auto-fills the address form
- **Select on map** — an interactive map where they search for an area or drag a pin to their exact doorstep

Both save latitude and longitude alongside the typed address, and both appear in the admin order detail with a map. Uses OpenStreetMap by default (no API key needed); add `GOOGLE_MAPS_API_KEY` for Google's more accurate Indian address data.

### Order tracking
At `/track.html`, customers enter their **Order ID and phone number** to see live status, a visual progress timeline, items, delivery address and estimated delivery date. Requiring both fields means nobody can look up someone else's order.

### Automatic notifications
Emails and WhatsApp messages fire on:

- Order placed (customer gets confirmation; you get an alert)
- Order accepted
- Order prepared
- Out for delivery
- Delivered
- Cancelled

Emails are branded HTML with a full order summary and a tracking button. If credentials aren't configured yet, messages are logged to your console instead of failing — so nothing breaks while you're setting up.

---

## Configuring notifications

Everything below is optional. Without credentials, the app runs fine and logs messages to the console.

### Email (Gmail example)

1. Enable 2-Step Verification on your Google account
2. Create an App Password at https://myaccount.google.com/apppasswords
3. In `.env`:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=yourstore@gmail.com
   SMTP_PASS=your-16-char-app-password
   SMTP_FROM=Sake of Health <yourstore@gmail.com>
   ```

### WhatsApp — Option A: Meta Cloud API (recommended)

Free tier, official. From https://developers.facebook.com/docs/whatsapp/cloud-api:

```
WHATSAPP_TOKEN=EAAxxxxx
WHATSAPP_PHONE_NUMBER_ID=1234567890
```

### WhatsApp — Option B: Twilio

Faster to set up for testing. From https://console.twilio.com/:

```
TWILIO_ACCOUNT_SID=ACxxxxx
TWILIO_AUTH_TOKEN=xxxxx
TWILIO_WHATSAPP_FROM=+14155238886
```

Test both from **Admin → Settings → Test Notifications**.

---

## Project Structure

```
├── src/
│   ├── server.js              Express app, security, routing
│   ├── seed.js                Demo data generator
│   ├── middleware/
│   │   ├── adminAuth.js       Login, HMAC tokens, role checks
│   │   └── idempotency.js     Duplicate-request protection
│   ├── routes/
│   │   ├── admin.js           All admin endpoints
│   │   ├── shop.js            Storefront: products, coupons, orders, tracking, geocoding
│   │   ├── checkout.js        Payment gateway orders
│   │   ├── track.js           Analytics events
│   │   └── blog.js            Blog (existing)
│   └── services/
│       ├── db.js              JSON persistence layer
│       ├── orders.js          Order lifecycle & status pipeline
│       ├── coupons.js         Discount validation engine
│       ├── notify.js          Email + WhatsApp
│       ├── reports.js         Dashboard metrics, analytics, CSV
│       └── payments.js        Razorpay / Cashfree
├── frontend/
│   ├── admin/                 Admin panel (11 pages)
│   ├── track.html             Customer order tracking
│   ├── checkout/              Checkout with location picker
│   └── assets/js/location-picker.js
└── data/                      JSON database (auto-created)
```

---

## Data storage

Orders, products, coupons, customers, reviews and staff are stored as JSON files in `data/`. No database installation needed — it works immediately and is easy to back up (just copy the folder) or inspect.

At high volume you'll want a real database. The `src/services/db.js` layer exposes standard `find` / `insert` / `update` / `remove` methods, so swapping in MongoDB means rewriting that one file — nothing else changes.

**Back up your data:**
```bash
cp -r data/ backups/data-$(date +%F)
```

---

## Useful commands

```bash
npm start          # Start the server
npm run dev        # Auto-restart on file changes
npm run seed       # Seed the database (skips existing data)
npm run reset      # Wipe and re-seed — deletes all orders
```

---

## Before you go live

- [ ] Change `ADMIN_EMAIL` and `ADMIN_PASSWORD`
- [ ] Set `ADMIN_JWT_SECRET` to a long random string
- [ ] Change all four seeded staff passwords
- [ ] Set `PAYMENT_MOCK=false` and add live Razorpay keys
- [ ] Add SMTP and WhatsApp credentials
- [ ] Set `NODE_ENV=production` and `SITE_URL` to your real domain
- [ ] Serve over HTTPS (browsers block location sharing on plain HTTP)
- [ ] Delete the demo orders: `npm run reset`, or clear `data/orders.json`
- [ ] Set up automatic backups of `data/`

---

## Testing verification

This build was verified with **87 API tests**, **37 client-logic tests** and **10 security checks**, covering authentication, order placement, the status pipeline, coupon rules, price-tampering defence, order tracking, role permissions, CSV exports, and XSS escaping.

Security measures in place:

- Passwords hashed with scrypt and per-user salts; hashes never sent to the client
- Session tokens signed with HMAC-SHA256 and expiry-checked
- Order totals recalculated server-side — a tampered client price is ignored
- Coupons re-validated on the server at order time
- Payment signatures verified before an order is marked paid
- Order tracking requires both order ID and phone, preventing enumeration
- Rate limiting on login (10 per 15 min), checkout and order placement
- All user content HTML-escaped before rendering

---

## What's new in this version

- **Cash on Delivery removed** — customers pay online before the order is placed.
- **Delete orders** — from both the Orders detail drawer and the Deliveries board (manager+ only).
- **Customer location on the map** now renders inside the admin order view, with a one-tap **Get directions** button.
- **Exact address capture** — after sharing location, customers add their door/flat number and landmark; the map "Select on map" picker is more reliable.
- **Customer reviews with photos** — a "Write a Review" form on the homepage lets customers rate, write and attach a photo. Reviews stay hidden until an admin approves them, then appear in the testimonials section.
- **Coupon display control** — in Settings, choose whether storefront coupons show on the homepage, below the products, or not at all. Only coupons marked "Show on storefront" appear.
- **Separate report files** — Orders, Sales, Deliveries, Customers and Products, with a shared date range.
- **Email diagnostics** — Settings shows exactly why email isn't sending and how to fix it.
- **Track Your Order** and **Admin Login** links in the storefront navbar and footer.
- **No demo data** — the store ships with your real catalogue only (no sample orders/customers/reviews). To explore with sample data, set `SEED_DEMO_DATA=true` in `.env` before first run.
