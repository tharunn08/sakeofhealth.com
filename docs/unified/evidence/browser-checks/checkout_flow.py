"""Browser check: storefront checkout in TEST (mock) mode — server quote shown,
tampered cart price corrected, order total equals the server quote."""
import json, os, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.environ.get('SOH_ROOT', '/home/claude/dev/soh')
data = tempfile.mkdtemp(prefix='soh-ui-data-'); priv = tempfile.mkdtemp(prefix='soh-ui-priv-')
env = dict(os.environ, PORT='5187', NODE_ENV='test', DATA_DIR=data, B2B_PRIVATE_DIR=priv, PAYMENT_MOCK='true', AUTO_SEED='true',
           ADMIN_EMAIL='admin@test.local', ADMIN_PASSWORD='Test@12345',
           ADMIN_JWT_SECRET='test-admin-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
           CUSTOMER_JWT_SECRET='test-customer-secret-0123456789-abcdefghijklmnopqrstuv', RAZORPAY_KEY_ID='', SMTP_HOST='')
srv = subprocess.Popen(['node', 'index.js'], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
base = 'http://127.0.0.1:5187'
for _ in range(100):
    try: urllib.request.urlopen(base + '/health'); break
    except Exception: time.sleep(0.15)
prods = json.load(urllib.request.urlopen(base + '/api/shop/products'))['products']
p = next(x for x in prods if not x['upcoming'])
print('product', p['slug'], 'catalogue price', p['price'])
results = []
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    for label, vp in [('desktop', {'width': 1366, 'height': 900}), ('mobile', {'width': 390, 'height': 844})]:
        ctx = b.new_context(viewport=vp); pg = ctx.new_page()
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('dialog', lambda d: (errs.append('dialog: ' + d.message), d.accept()))
        pg.goto(base + '/')
        # tampered cart: price 1 instead of the catalogue price
        pg.evaluate("c => localStorage.setItem('soh_cart', JSON.stringify(c))", [{'id': p['id'], 'name': p['name'], 'price': 1, 'image': '', 'qty': 2}])
        pg.goto(base + '/checkout/'); pg.wait_for_timeout(1200)
        sb_total = pg.inner_text('#sb-total'); sb_sub = pg.inner_text('#sb-subtotal')
        quote = pg.evaluate("state.quote")
        cart_price = pg.evaluate("sohCart.get()[0].price")
        pg.screenshot(path=f'/home/claude/dev/checks/checkout-{label}-cart.png', full_page=False)
        pg.click('#btn-to-2')
        pg.fill('#f-fname', 'Ui'); pg.fill('#f-lname', 'Tester'); pg.fill('#f-email', 'ui@test.local'); pg.fill('#f-phone', '9876543210')
        pg.click('text=Delivery Address →')
        pg.fill('#f-door', '1'); pg.fill('#f-addr1', 'MG Road'); pg.fill('#f-city', 'Bengaluru'); pg.fill('#f-pincode', '560001')
        pg.select_option('#f-state', label='Karnataka')
        pg.click('#step-3 .btn-next'); pg.wait_for_timeout(700)
        pay_total = pg.inner_text('#pay-total')
        pg.screenshot(path=f'/home/claude/dev/checks/checkout-{label}-review.png', full_page=False)
        pg.click('#btn-pay'); pg.wait_for_url('**/success.html**', timeout=10000)
        url = pg.url
        orders = json.load(open(os.path.join(data, 'orders.json')))
        o = orders[-1]
        r = dict(view=label, sidebar_subtotal=sb_sub, sidebar_total=sb_total, quote_total=quote and quote['total'], cart_price_after=cart_price,
                 pay_button_total=pay_total, order_total=o['total'], order_line_price=o['items'][0]['price'], success_url=url.split('/')[-1], page_errors=errs)
        results.append(r); print(json.dumps(r))
        ctx.close()
    b.close()
finally:
    srv.terminate()
ok = all(r['order_total'] == r['quote_total'] and str(r['quote_total']) in r['sidebar_total'] and str(r['quote_total']) == r['pay_button_total']
         and r['order_line_price'] == p['price'] and r['cart_price_after'] == p['price'] and not r['page_errors'] for r in results)
print('RESULT', 'PASS' if ok else 'FAIL')
sys.exit(0 if ok else 1)
