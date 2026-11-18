"""Operations screens (shop stock, events, locations, offline sync, all customers) inside the central
/admin, and the field app's offline queue — BROWSER CHECK OF THE SCREENS ONLY.
The real server runs (B2B + ERP enabled, business database unreachable). Every /api/erp and
/api/sales call is answered by labelled TEST FIXTURES below; this proves what the screens send and
show (one press = one request, the right keys, offline → queued → sent once), not the business
results (those are in the MySQL 8 suites)."""
import json, os, subprocess, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright
ROOT = os.environ.get('SOH_ROOT', '/home/claude/dev/soh'); OUT = '/home/claude/dev/checks/ops'; os.makedirs(OUT, exist_ok=True)
FIX = json.load(open('/home/claude/dev/checks/erp-fixture.json'))
ERP_SECRET = 'unit-test-erp-secret-0123456789abcdef'
env = dict(os.environ, PORT='5195', NODE_ENV='test', DATA_DIR=tempfile.mkdtemp(), B2B_PRIVATE_DIR=tempfile.mkdtemp(), PAYMENT_MOCK='true', AUTO_SEED='true',
  ADMIN_EMAIL='admin@test.local', ADMIN_PASSWORD='Test@12345', B2B_ENABLED='true', ERP_ENABLED='true', B2B_JWT_SECRET='test-b2b-secret-not-for-production-123',
  ERP_JWT_SECRET=ERP_SECRET, DB_HOST='127.0.0.1', DB_PORT='1', DB_USER='nobody', DB_PASSWORD='x', DB_NAME='nothing',
  ADMIN_JWT_SECRET='test-admin-secret-0123456789-abcdefghijklmnopqrstuvwxyz', CUSTOMER_JWT_SECRET='test-customer-secret-0123456789-abcdefghijklmnopqrstuv', RAZORPAY_KEY_ID='', SMTP_HOST='')
srv = subprocess.Popen(['node', 'index.js'], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
base = 'http://127.0.0.1:5195'
for _ in range(100):
    try: urllib.request.urlopen(base + '/health'); break
    except Exception: time.sleep(0.15)
erp_tok = subprocess.run(['node', '-e', "process.env.ERP_JWT_SECRET='%s';process.stdout.write(require('./src/modules/erp/core/security.js').sign({sid:1,tv:0,mfa:true,ses:'check'}))" % ERP_SECRET], cwd=ROOT, capture_output=True, text=True, env=dict(env)).stdout

NEW = ['shop_stock.view', 'shop_stock.resolve', 'shop_stock.refund.pay', 'events.view', 'events.manage', 'events.sell', 'events.sales.void', 'events.reports.view', 'locations.view', 'locations.capture',
       'offline.view', 'offline.resolve', 'customers.view', 'customers.contacts.view', 'customers.link.manage']
perms = FIX['perms'] + NEW
nav = json.loads(json.dumps(FIX['nav']))
ITEMS = {'/admin/inventory/': ('erp-shopstock', 'Online Shop Stock', '/admin/inventory/shop-stock', 'store', 'shopstock'),
         '/admin/sales/': ('erp-events', 'Events & Counter Sales', '/admin/sales/events', 'tag', 'events'),
         '/admin/administration/': ('erp-offline', 'Offline Sync', '/admin/administration/offline-sync', 'refresh', 'offline')}
for g in nav['groups']:
    for pre, it in ITEMS.items():
        if any(i['path'].startswith(pre) for i in g['items']):
            g['items'].insert(0, {'id': it[0], 'label': it[1], 'path': it[2], 'icon': it[3], 'badge': None, 'module': 'erp', 'view': it[4]})
    if any(i['path'].startswith('/admin/sales/') for i in g['items']):
        g['items'].insert(1, {'id': 'erp-locations', 'label': 'Field & Event Locations', 'path': '/admin/sales/locations', 'icon': 'map', 'badge': None, 'module': 'erp', 'view': 'locations'})
    if any(i['path'].startswith('/admin/customers/') for i in g['items']):
        g['items'].append({'id': 'erp-customers', 'label': 'All Customers', 'path': '/admin/customers/all', 'icon': 'customers', 'badge': None, 'module': 'erp', 'view': 'customers'})
me = {'id': 1, 'name': 'UI Check', 'email': 'ui@check.local', 'roles': ['super_admin'], 'permissions': perms, 'scopes': {'territory': 'all', 'warehouse': 'all', 'state': 'all'}, 'mfa': True}
T = '(TEST FIXTURE) '
overview = {'mode': 'shadow', 'warehouse': {'id': 9, 'code': 'SHOP1', 'name': T + 'Online shop', 'warehouse_type': 'online_shop'}, 'holdMinutes': 30, 'autoRefund': False, 'mapped': 11, 'shopProducts': 12,
            'unmappedShop': ['p-x'], 'openHolds': 2, 'openDiscrepancies': 3, 'openExceptions': 1, 'lastSync': {'last_run_at': '2026-11-16T10:00:00Z', 'last_result': '{}'}, 'readyToEnforce': False,
            'blockers': ['1 shop product(s) have no business product mapped; their stock cannot be enforced.']}
exc = {'items': [{'id': 4, 'ref': 'gw:order_FIX1', 'gatewayOrderId': 'order_FIX1', 'paymentId': 'pay_FIX1', 'kind': 'paid_short', 'amount': 360, 'details': {'short': [{'name': T + 'Jaggery', 'left': 0, 'wanted': 3}]}, 'status': 'open', 'refundRef': None, 'refundError': None, 'note': None, 'createdAt': '2026-11-16T10:00:00Z'}]}
events = {'items': [{'id': 3, 'code': 'BLR', 'name': T + 'Bengaluru expo', 'venue': 'Palace grounds', 'city': 'Bengaluru', 'stateId': 29, 'warehouseId': 40, 'startsOn': '2026-11-20', 'endsOn': '2026-11-22', 'status': 'open', 'invoicePrefix': 'EV', 'sales': 1, 'revenue': 240}]}
event = dict(events['items'][0], staff=[{'id': 7, 'name': T + 'Asha', 'email': 'asha@fixture.test'}])
stock = {'event': events['items'][0], 'items': [{'productId': 5, 'sku': 'JAG1', 'name': T + 'Jaggery 1 kg', 'mrp': 120, 'gstRate': 5, 'hsn': '1701', 'available': 8, 'damaged': 0, 'expired': 0, 'nextExpiry': '2027-01-31'}]}
sales = {'items': [{'id': 501, 'invoiceNo': 'EV/2627/00001', 'eventId': 3, 'eventCode': 'BLR', 'customer': T + 'Meena', 'total': 240, 'paid': 240, 'paymentStatus': 'paid', 'status': 'completed', 'soldAt': '2026-11-16T10:00:00Z', 'offline': True, 'seller': T + 'Asha'}]}
sale = {'id': 501, 'invoiceNo': 'EV/2627/00001', 'event': {'id': 3, 'code': 'BLR', 'name': T + 'Bengaluru expo'}, 'status': 'completed', 'soldAt': '2026-11-16T10:00:00Z', 'seller': T + 'Asha',
        'customer': {'name': T + 'Meena'}, 'interstate': False, 'offline': True, 'totals': {'grand': 240, 'paid': 240}, 'paymentStatus': 'paid',
        'items': [{'id': 601, 'sku': 'JAG1', 'name': T + 'Jaggery 1 kg', 'batchNo': 'E-1', 'expiry': '2027-01-31', 'qty': 2, 'returned': 0, 'total': 240}], 'payments': [], 'returns': [], 'voided': None}
report = {'totals': {'invoices': 1, 'revenue': 240, 'tax': 11.42, 'collected': 240}, 'byEvent': [{'code': 'BLR', 'name': T + 'Bengaluru expo', 'invoices': 1, 'units': 2, 'revenue': 240}], 'byMethod': [{'method': 'upi', 'net': 240}], 'byDay': [], 'returns': [], 'byProduct': []}
points = {'points': [{'id': 1, 'subject': 'salesman', 'subjectId': 2, 'subjectName': T + 'Ravi', 'lat': 12.97, 'lng': 77.59, 'source': 'gps', 'purpose': 'visit', 'accuracyM': 15, 'capturedAt': '2026-11-16T09:00:00Z'},
                     {'id': 2, 'subject': 'event', 'subjectId': 3, 'subjectName': T + 'Bengaluru expo', 'lat': 12.998, 'lng': 77.592, 'source': 'gps', 'purpose': 'stall', 'accuracyM': 12, 'capturedAt': '2026-11-16T09:30:00Z'}], 'events': []}
ops = {'counts': {'applied': 4, 'conflict': 1}, 'items': [{'id': 9, 'clientOpId': '11111111-2222-4333-8444-555555555555', 'staffName': T + 'Asha', 'kind': 'event_sale', 'status': 'conflict', 'attempts': 1, 'error': 'Not enough stock at BLR', 'firstReceivedAt': '2026-11-16T10:00:00Z', 'createdOfflineAt': '2026-11-16T09:40:00Z'}]}
op = dict(ops['items'][0], payload={'eventId': 3, 'items': [{'productId': 5, 'qty': 9}]}, result=None, note=None, deviceId='dev-1')
custs = {'total': 1, 'page': 1, 'size': 50, 'items': [{'id': 21, 'name': T + 'Meena', 'email': 'm•••@trial.local', 'mobile': '98•••••222', 'sources': ['event_sale', 'b2c_customer'], 'review': True, 'orders': 2, 'spent': 600, 'lastSeenAt': '2026-11-16T10:00:00Z'}]}

ok = True
results = []
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    for view, vp in [('desktop', {'width': 1360, 'height': 900}), ('mobile', {'width': 390, 'height': 844})]:
        ctx = b.new_context(viewport=vp); pg = ctx.new_page(); errs = []; posts = []; gets = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('dialog', lambda d: d.accept('Seal broken at the stall' if d.type == 'prompt' else None))
        def erp_api(route):
            r = route.request; u = r.url.replace(base, '')
            if r.method != 'GET':
                body = json.loads(r.post_data or '{}'); posts.append((u, body)); time.sleep(0.25)
                if '/events/sales' in u and u.endswith('/sales'): return route.fulfill(status=201, json=dict(sale, invoiceNo='EV/2627/00002', id=502))
                if u.endswith('/refund'): return route.fulfill(json={'id': 4, 'status': 'refunded', 'refundRef': 'rfnd_fix'})
                if u.endswith('/retry'): return route.fulfill(json={'id': 9, 'status': 'applied'})
                if u.endswith('/customers/import'): return route.fulfill(json={'linked': 3, 'created': 1, 'review': 1, 'orders': 2, 'accounts': 0, 'unreadable': []})
                return route.fulfill(json={'ok': True})
            gets.append((u, r.headers.get('authorization')))
            if u.startswith('/api/erp/core/me'): return route.fulfill(json=me)
            if u.startswith('/api/erp/shop-stock/overview'): return route.fulfill(json=overview)
            if u.startswith('/api/erp/shop-stock/exceptions'): return route.fulfill(json=exc)
            if u.startswith('/api/erp/shop-stock/'): return route.fulfill(json={'items': []})
            if u.startswith('/api/erp/events/report'): return route.fulfill(json=report)
            if u.startswith('/api/erp/events/sales/501/invoice'): return route.fulfill(body='<!doctype html><title>Invoice EV/2627/00001</title><p>' + T + 'invoice</p>', content_type='text/html')
            if u.startswith('/api/erp/events/sales/501'): return route.fulfill(json=sale)
            if u.startswith('/api/erp/events/sales'): return route.fulfill(json=sales)
            if u.startswith('/api/erp/events/3/stock'): return route.fulfill(json=stock)
            if u.startswith('/api/erp/events/3'): return route.fulfill(json=event)
            if u.startswith('/api/erp/events'): return route.fulfill(json=events)
            if u.startswith('/api/erp/locations/map'): return route.fulfill(json=points)
            if u.startswith('/api/erp/locations/attendance'): return route.fulfill(json={'from': '2026-11-10', 'to': '2026-11-16', 'items': []})
            if u.startswith('/api/erp/locations'): return route.fulfill(json={'items': points['points']})
            if u.startswith('/api/erp/offline/ops/9'): return route.fulfill(json=op)
            if u.startswith('/api/erp/offline/ops'): return route.fulfill(json=ops)
            if u.startswith('/api/erp/customers'): return route.fulfill(json=custs)
            return route.fulfill(json={'items': []})
        pg.route('**/api/erp/**', erp_api)
        pg.route('**/api/platform/nav', lambda route: route.fulfill(json=nav))
        pg.goto(base + '/login'); pg.fill('#email', 'admin@test.local'); pg.fill('#password', 'Test@12345'); pg.click('#submitBtn'); pg.wait_for_url('**/admin/*/*')
        pg.evaluate("t => localStorage.setItem('soh_erp_token', t)", erp_tok)
        # shop stock: blockers shown; refund needs a confirm and sends one request
        pg.goto(base + '/admin/inventory/shop-stock', wait_until='networkidle'); pg.wait_for_timeout(400)
        shop_ok = pg.is_visible('text=Before enforcing') and pg.is_visible('text=Mode: shadow.')
        pg.click('button.ntab:has-text("Paid but short")'); pg.wait_for_timeout(300)
        pg.screenshot(path='%s/%s-1-shop-stock.png' % (OUT, view), full_page=True)
        pg.click('button:has-text("Refund")'); pg.wait_for_timeout(600)
        refund_ok = len([p for p in posts if p[0].endswith('/exceptions/4/refund')]) == 1
        # events: a counter sale, pressed twice → one request with a UUID key; invoice opens with the staff token
        pg.goto(base + '/admin/sales/events', wait_until='networkidle'); pg.wait_for_timeout(400)
        pg.click('button:has-text("Open")'); pg.wait_for_timeout(600)
        pg.fill('input[aria-label="Quantity of %sJaggery 1 kg"]' % T, '2')
        pg.fill('input[aria-label="Customer name"]', 'Walk-in')
        pg.select_option('select[aria-label="Paid by"]', 'upi'); pg.fill('input[aria-label="Amount paid"]', '240')
        pg.dblclick('button:has-text("Confirm sale")'); pg.wait_for_timeout(900)
        sp = [p for p in posts if p[0] == '/api/erp/events/sales']
        sale_ok = len(sp) == 1 and len(sp[0][1].get('idempotencyKey', '')) == 36 and sp[0][1]['items'] == [{'productId': 5, 'qty': 2}] and sp[0][1]['payments'] == [{'method': 'upi', 'amount': 240}]
        pg.screenshot(path='%s/%s-2-events.png' % (OUT, view), full_page=True)
        pg.wait_for_timeout(900)
        pg.locator('tr:has-text("EV/2627/00001") button:has-text("Open")').first.click(); pg.wait_for_timeout(500)
        with pg.expect_popup() as pop: pg.click('button:has-text("Print / PDF")')
        inv = pop.value; inv.wait_for_load_state(); invoice_ok = 'Invoice EV/2627/00001' in inv.title()
        inv_auth = any(u.startswith('/api/erp/events/sales/501/invoice') and a and a.startswith('Bearer ') for u, a in gets)
        inv.close()
        # locations: points drawn from the recorded fixes
        pg.goto(base + '/admin/sales/locations', wait_until='networkidle'); pg.wait_for_timeout(500)
        dots = pg.eval_on_selector_all('svg[aria-label="2 locations"] circle', 'e => e.length')
        loc_ok = dots == 2 and pg.is_visible('text=Open map')
        pg.screenshot(path='%s/%s-3-locations.png' % (OUT, view), full_page=True)
        # offline sync: a conflict opens with what the device sent; retry is one request
        pg.goto(base + '/admin/administration/offline-sync', wait_until='networkidle'); pg.wait_for_timeout(400)
        pg.click('button:has-text("Open")'); pg.wait_for_timeout(400)
        pg.click('button:has-text("Retry as")'); pg.wait_for_timeout(600)
        off_ok = len([p for p in posts if p[0].endswith('/offline/ops/9/retry')]) == 1 and pg.is_visible('text=What the device sent')
        pg.screenshot(path='%s/%s-4-offline.png' % (OUT, view), full_page=True)
        # customers: masked contacts, review flag, import
        pg.goto(base + '/admin/customers/all', wait_until='networkidle'); pg.wait_for_timeout(400)
        pg.click('button:has-text("Import / refresh from the shop")'); pg.wait_for_timeout(600)
        cust_ok = pg.is_visible('text=m•••@trial.local') and pg.is_visible('text=Linked 3') and len([p for p in posts if p[0].endswith('/customers/import')]) == 1
        pg.screenshot(path='%s/%s-5-customers.png' % (OUT, view), full_page=True)
        good = shop_ok and refund_ok and sale_ok and invoice_ok and inv_auth and loc_ok and off_ok and cust_ok and not errs
        results.append(good)
        print('PASS' if good else 'FAIL', view, '| shop stock blockers', shop_ok, '| refund one request', refund_ok, '| sale one request + key', sale_ok, '| invoice opens', invoice_ok, 'with token', inv_auth,
              '| map dots', dots, '| offline retry', off_ok, '| customers', cust_ok, '| page errors', errs)
        ctx.close()

    # ── the field app: a sale while offline is kept, then sent once when the connection returns ──
    ctx = b.new_context(viewport={'width': 390, 'height': 844}); pg = ctx.new_page(); errs = []; synced = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    def field_api(route):
        r = route.request; u = r.url.replace(base, '')
        if u.startswith('/api/sales/me'): return route.fulfill(status=403, json={'error': 'You are not set up as a salesman', 'code': 'not_salesman'})
        if u.startswith('/api/erp/offline/sync'):
            body = json.loads(r.post_data or '{}'); synced.append(body)
            return route.fulfill(json={'results': [{'clientOpId': o['clientOpId'], 'status': 'applied', 'result': {'saleId': 777, 'invoiceNo': 'EV/2627/00077'}} for o in body['ops']]})
        if u.startswith('/api/erp/events/3/stock'): return route.fulfill(json=stock)
        if u.startswith('/api/erp/events'): return route.fulfill(json=events)
        return route.fulfill(json={})
    pg.route('**/api/sales/**', field_api); pg.route('**/api/erp/**', field_api)
    pg.goto(base + '/sales-app/', wait_until='networkidle')
    pg.evaluate("t => sessionStorage.setItem('sales.token', t)", erp_tok)
    pg.goto(base + '/sales-app/', wait_until='networkidle'); pg.wait_for_timeout(600)
    pg.click('button:has-text("Open counter")'); pg.wait_for_timeout(600)
    pg.fill('input[aria-label="Quantity of %sJaggery 1 kg"]' % T, '2')
    ctx.set_offline(True)
    pg.click('button:has-text("Confirm sale")'); pg.wait_for_timeout(800)
    saved = pg.is_visible('text=No connection: saved on this phone')
    stored = pg.evaluate("""() => new Promise(r => { const q = indexedDB.open('soh-field'); q.onsuccess = () => { const t = q.result.transaction('ops').objectStore('ops').getAll(); t.onsuccess = () => r(t.result); }; })""")
    waiting = pg.is_visible('text=1 waiting to send')
    pg.screenshot(path='%s/field-1-offline-saved.png' % OUT, full_page=True)
    ctx.set_offline(False)
    pg.evaluate("window.dispatchEvent(new Event('online'))"); pg.wait_for_timeout(2500)
    after = pg.evaluate("""() => new Promise(r => { const q = indexedDB.open('soh-field'); q.onsuccess = () => { const t = q.result.transaction('ops').objectStore('ops').getAll(); t.onsuccess = () => r(t.result.length); }; })""")
    pg.screenshot(path='%s/field-2-synced.png' % OUT, full_page=True)
    same_key = len(stored) == 1 and synced and synced[0]['ops'][0]['clientOpId'] == stored[0]['clientOpId'] == stored[0]['payload']['idempotencyKey']
    field_ok = saved and waiting and len(stored) == 1 and stored[0]['kind'] == 'event_sale' and len(synced) == 1 and same_key and after == 0 and pg.is_visible('text=EV/2627/00077') and not errs
    results.append(field_ok)
    print('PASS' if field_ok else 'FAIL', 'field app | saved offline', saved, '| shown waiting', waiting, '| stored ops', len(stored), '| sent once', len(synced), '| same id as the sale key', bool(same_key), '| left on phone', after, '| errors', errs)
    b.close()
finally:
    srv.terminate()
print('RESULT', 'PASS' if all(results) and results else 'FAIL')
