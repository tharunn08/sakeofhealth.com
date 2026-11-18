# Setup Guide — Step by Step

A plain-language walkthrough. Follow it in order.

---

## Step 1 — Install and run

Open a terminal in the project folder:

```bash
npm install
npm start
```

You should see:

```
  Sake of Health
  Server:     http://localhost:3000
  Admin:      http://localhost:3000/admin/
  Payments:   TEST MODE (mock)
```

Leave this running. Open a second terminal for other commands.

---

## Step 2 — Log in to the admin panel

Go to **http://localhost:3000/admin/**

```
Email:    admin@sakeofhealth.com
Password: ChangeMe@2026
```

You'll land on the dashboard with demo data already populated so you can see how everything looks in use.

---

## Step 3 — Change your admin password

Open `.env` and edit these three lines:

```
ADMIN_EMAIL=your-real-email@gmail.com
ADMIN_PASSWORD=SomethingLongAndHardToGuess
ADMIN_JWT_SECRET=paste-40-plus-random-characters-here
```

Save, then restart the server (`Ctrl+C`, then `npm start`).

> `ADMIN_JWT_SECRET` signs login sessions. Changing it logs everyone out — which is exactly what you want if you ever suspect a leak.

---

## Step 4 — Place a test order

1. Go to http://localhost:3000
2. Add something to the cart, go to checkout
3. On the address step, click **"Share my location"** and allow it — the address fills in automatically
4. Try a coupon: `WELCOME10`
5. Pick either payment option and complete the order

Because test mode is on, nothing is charged.

Now check your terminal — you'll see the confirmation email and WhatsApp message that were generated:

```
[EMAIL:MOCK] To: you@example.com
  Subject: Order Confirmed — SOH-20260724-0001
[WHATSAPP:MOCK] To: +919876543210
```

They're logged rather than sent because you haven't added credentials yet. That's Step 6.

---

## Step 5 — Fulfil the order

1. Admin → **Orders** → click your new order
2. You'll see the customer's address, GPS location on a map, items and payment
3. Click **Accepted** → **Prepared** → **Out for Delivery** → **Delivered**

Each click notifies the customer.

Now open **http://localhost:3000/track.html**, enter the Order ID and the phone number you used, and you'll see the tracking timeline the customer sees.

---

## Step 6 — Turn on real email

Using Gmail:

1. Turn on 2-Step Verification: https://myaccount.google.com/security
2. Create an App Password: https://myaccount.google.com/apppasswords
   - Select "Mail", name it "Sake of Health", copy the 16-character code
3. In `.env`:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=yourstore@gmail.com
SMTP_PASS=abcd efgh ijkl mnop
SMTP_FROM=Sake of Health <yourstore@gmail.com>
```

4. Restart, then go to **Admin → Settings → Test Notifications**, enter your email, and send.

> Use the App Password, not your normal Gmail password.

---

## Step 7 — Turn on WhatsApp

### Quickest: Twilio sandbox

1. Sign up at https://www.twilio.com/try-twilio
2. Go to Messaging → Try it out → Send a WhatsApp message
3. Follow the instructions to join the sandbox from your phone
4. Copy your Account SID and Auth Token into `.env`:

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxx
TWILIO_WHATSAPP_FROM=+14155238886
```

### Production: Meta WhatsApp Cloud API

Free tier and no sandbox restrictions, but requires business verification.

1. https://developers.facebook.com/ → Create App → Business
2. Add the WhatsApp product
3. Copy the temporary token and Phone Number ID:

```
WHATSAPP_TOKEN=EAAxxxxx
WHATSAPP_PHONE_NUMBER_ID=1234567890
```

4. Generate a permanent token before going live (temporary ones expire in 24 hours)

Test from **Admin → Settings**.

---

## Step 8 — Add your products

Admin → **Products** → **Add Product**

Your 4 existing products are already loaded. To add more:

- **Name, price, MRP** — MRP shows as a struck-through "was" price
- **Stock** — leave blank for unlimited; the storefront marks 0 as out of stock
- **Image** — put the file in `frontend/assets/images/` and enter `/assets/images/yourfile.png`
- **Highlights** — one per line, appears as bullets
- **Upcoming** — tick this for products not yet launched; shows "Coming Soon", purchasing disabled

Anything you save appears on the storefront immediately.

---

## Step 9 — Create coupons

Admin → **Coupons** → **Create Coupon**

Example — 15% off orders above ₹999, capped at ₹300, expiring in a month:

```
Code:               FESTIVE15
Type:               Percentage off
Percentage:         15
Maximum discount:   300
Minimum order:      999
Expires on:         (pick a date)
Show on storefront: ✓
```

With "Show on storefront" ticked, it appears in the offers strip at checkout and customers can tap to apply it. Untick it for private codes that only work when typed.

---

## Step 10 — Add your team

Admin → **Staff** → **Add Staff**

Give delivery agents the `delivery` role and enter their phone number — they'll get WhatsApp alerts with the address and map link when you assign them an order.

Delete or change the password on the four seeded demo accounts before going live.

---

## Step 11 — Going live

1. **Real payments:**
   ```
   PAYMENT_MOCK=false
   RAZORPAY_KEY_ID=rzp_live_xxxxx
   RAZORPAY_KEY_SECRET=xxxxx
   ```

2. **Production settings:**
   ```
   NODE_ENV=production
   SITE_URL=https://yourdomain.com
   ```

3. **Clear the demo data:**
   ```bash
   npm run reset
   ```
   This wipes all orders and re-seeds the catalogue. Do this *before* taking real orders.

4. **Use HTTPS.** Browsers block location sharing on plain HTTP, so "Share my location" will not work without it.

5. **Set up backups:**
   ```bash
   cp -r data/ backups/data-$(date +%F)
   ```

---

## Troubleshooting

**"Invalid credentials" when logging in**
Check `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env` and restart the server. The email is case-insensitive; the password is not.

**Emails aren't arriving**
Check Admin → Settings — it shows whether email is connected. With Gmail, make sure you used an App Password. Check your spam folder.

**"Share my location" does nothing**
Location needs HTTPS (except on `localhost`). If the customer blocked the permission, they'll need to re-enable it in their browser settings — the "Select on map" button always works as a fallback.

**The map won't load**
It loads from a CDN, so it needs internet access. Customers can still type their address manually.

**Locked out after too many login attempts**
Rate limiting blocks 10 failed attempts per 15 minutes. Wait it out, or restart the server to clear it.

**Port 3000 already in use**
Change `PORT=3001` in `.env`, or stop the other process:
```bash
lsof -ti:3000 | xargs kill -9
```

**I want to start completely fresh**
```bash
rm -f data/*.json
npm start
```
