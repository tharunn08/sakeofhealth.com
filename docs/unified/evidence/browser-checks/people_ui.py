"""Suppliers & manufacturers, salesmen, delivery, admin menu scroll, the four permanent products —
BROWSER CHECK OF THE SCREENS. The real server runs (shop data in a throw-away folder; B2B + ERP enabled,
business database unreachable). Business API calls are answered by labelled TEST FIXTURES; this proves
what the screens send and show, not the business results (those are in the MySQL 8 suites)."""
import json, os, subprocess, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright
ROOT = os.environ.get('SOH_ROOT', '/home/claude/dev/soh'); OUT = '/home/claude/dev/checks/people'; os.makedirs(OUT, exist_ok=True)
FIX = json.load(open('/home/claude/dev/checks/erp-fixture.json'))
ERP_SECRET = 'browser-check-erp-secret-not-for-production-0123456789abcdefghij'
DATA = tempfile.mkdtemp()
env = dict(os.environ, PORT='5197', NODE_ENV='production', DATA_DIR=DATA, CATALOGUE_DIR=os.path.join(DATA, '.cat'), BACKUP_DIR=os.path.join(DATA, '.bak'),
  B2B_PRIVATE_DIR=tempfile.mkdtemp(), PAYMENT_MOCK='true', AUTO_SEED='true',
  ADMIN_EMAIL='admin@test.local', ADMIN_PASSWORD='Test@12345', B2B_ENABLED='true', ERP_ENABLED='true', B2B_JWT_SECRET='test-b2b-secret-not-for-production-123',
  ERP_JWT_SECRET=ERP_SECRET, DB_HOST='127.0.0.1', DB_PORT='1', DB_USER='nobody', DB_PASSWORD='x', DB_NAME='nothing', TRUST_PROXY='',
  ADMIN_JWT_SECRET='test-admin-secret-0123456789-abcdefghijklmnopqrstuvwxyz', CUSTOMER_JWT_SECRET='test-customer-secret-0123456789-abcdefghijklmnopqrstuv', RAZORPAY_KEY_ID='', SMTP_HOST='')
srv = subprocess.Popen(['node', 'index.js'], cwd=ROOT, env=env, stdout=open(os.path.join(DATA, 'server.log'), 'w'), stderr=subprocess.STDOUT)
base = 'http://127.0.0.1:5197'
for _ in range(150):
    try: urllib.request.urlopen(base + '/health'); break
    except Exception: time.sleep(0.15)
erp_tok = subprocess.run(['node', '-e', "process.env.ERP_JWT_SECRET='%s';process.stdout.write(require('./src/modules/erp/core/security.js').sign({sid:1,tv:0,mfa:true,ses:'check'}))" % ERP_SECRET], cwd=ROOT, capture_output=True, text=True, env=dict(env)).stdout

perms = sorted(set(FIX['perms'] + ['vendors.view', 'vendors.create', 'vendors.verify', 'vendors.products.approve', 'sales.reports.view', 'sales.targets.edit', 'sales.collections.confirm', 'core.staff.edit', 'core.staff.view',
                                   'deliveries.view', 'deliveries.manage', 'deliveries.update', 'manufacturing.view']))
nav = json.loads(subprocess.run(['node', '-e', "const r=require('./src/platform/registry.js');process.stdout.write(JSON.stringify(r.navFor('admin',true,{enabled:true,permissions:new Set(%s)})))" % json.dumps(perms)],
                                cwd=ROOT, capture_output=True, text=True, env=dict(env)).stdout.strip().splitlines()[-1])
me = {'id': 1, 'name': 'UI Check', 'email': 'ui@check.local', 'roles': ['super_admin'], 'permissions': perms, 'scopes': {'territory': 'all', 'warehouse': 'all', 'state': 'all'}, 'mfa': True}
T = '(TEST FIXTURE) '

vlist = {'byStatus': {'approved': 3, 'submitted': 1, 'under_verification': 1, 'more_info_required': 0, 'suspended': 0, 'draft': 1}, 'items': [
  {'id': 8, 'vendor_code': 'V00008', 'legal_name': T + 'Mandya Cane Products', 'trade_name': 'Mandya Cane', 'gstin': '29AAACM1234F1Z5', 'status': 'approved', 'capabilities': 'contract_manufacturer:approved,manufacturer:requested',
   'docs_pending': 1, 'banks_pending': 1, 'products_pending': 1, 'owner': {'name': 'Kiran', 'email': 'kiran@maker.test', 'mobile': '9876500001', 'status': 'active', 'lastLoginAt': '2026-11-17 10:00:00'}, 'city': 'Mandya', 'state': 'Karnataka'}]}
vdetail = {'vendor': {'id': 8, 'vendor_code': 'V00008', 'legal_name': T + 'Mandya Cane Products', 'trade_name': 'Mandya Cane', 'gstin': '29AAACM1234F1Z5', 'pan': 'AAACM1234F', 'fssai_licence': '10019043000123', 'fssai_valid_to': '2027-12-31',
   'status': 'approved', 'onboarding': 'self', 'payment_terms_days': 30, 'default_lead_days': 10, 'created_at': '2026-11-01 10:00:00', 'approved_at': '2026-11-05 10:00:00'},
  'capabilities': [{'capability': 'contract_manufacturer', 'status': 'approved', 'decided_at': '2026-11-05'}, {'capability': 'manufacturer', 'status': 'requested', 'decided_at': None}],
  'users': [{'id': 3, 'name': 'Kiran', 'email': 'kiran@maker.test', 'mobile': '9876500001', 'role': 'owner', 'status': 'active', 'lastLoginAt': '2026-11-17 10:00:00', 'mustChangePassword': False, 'locked': False}],
  'addresses': [{'id': 1, 'type': 'factory', 'line1': 'Plot 4, KIADB', 'line2': None, 'city': 'Mandya', 'stateId': 12, 'state': 'Karnataka', 'pincode': '571401', 'latitude': 12.5, 'longitude': 76.9}],
  'bankAccounts': [{'id': 5, 'accountName': 'Mandya Cane', 'accountMasked': 'XXXX9012', 'ifsc': 'HDFC0001234', 'status': 'pending', 'verifiedBy': None, 'addedAt': '2026-11-10'}],
  'documents': [{'id': 2, 'doc_type': 'fssai_licence', 'original_name': 'fssai.pdf', 'valid_to': '2027-12-31', 'review_status': 'pending', 'review_note': None, 'created_at': '2026-11-02'}],
  'verifications': [], 'state': {'id': 12, 'name': 'Karnataka', 'gst_code': '29'},
  'trade': {'purchaseOrders': {'count': 3, 'open': 1, 'value': 18900}, 'manufacturingOrders': {'count': 2, 'open': 1}, 'deliveries': {'count': 3, 'inTransit': 1}},
  'products': [{'id': 11, 'name': T + 'Jaggery 1 kg', 'brand': None, 'vendor_sku': 'MJ1', 'hsn_code': '1701', 'mrp': '120.00', 'pack_size': '1 kg', 'status': 'submitted', 'review_note': None, 'mapped_sku': None, 'mapped_name': None}],
  'prices': [{'id': 21, 'product': T + 'Jaggery 1 kg', 'unit_price': '60.0000', 'gst_rate': '5.00', 'discount_pct': '0.0000', 'freight_per_unit': '0.0000', 'moq': 50, 'lead_days': 10, 'valid_from': '2026-11-01', 'valid_to': None, 'status': 'submitted'}]}
states = {'items': [{'id': 12, 'name': 'Karnataka', 'gst_code': '29'}, {'id': 13, 'name': 'Kerala', 'gst_code': '32'}]}
sm_list = {'month': '2026-11', 'totals': {'salesmen': 1, 'todayOrders': 2, 'todayValue': 4200, 'todayVisits': 5, 'monthValue': 86000, 'cashInHand': 23500, 'overCashLimit': 1}, 'items': [
  {'id': 4, 'staffId': 9, 'name': T + 'Ravi Kumar', 'email': 'ravi@soh.test', 'mobile': '9845000009', 'employeeCode': 'SM-01', 'active': True, 'territory': 'Bengaluru South', 'territoryId': 2, 'warehouse': 'Bengaluru DC', 'warehouseId': 3, 'cashLimit': 20000,
   'numbers': {'month': '2026-11', 'today': {'orders': 2, 'value': 4200, 'visits': 5, 'collected': 3000}, 'monthToDate': {'sales_value': 86000, 'orders': 31, 'collections': 52000, 'visits': 88},
               'target': {'sales_value': 100000}, 'achievementPct': {'sales_value': 86}, 'cashInHand': 23500, 'cashReceiptsPending': 2},
   'lastLocationAt': '2026-11-18 09:30:00', 'lastVisit': {'at': '2026-11-18 09:30:00', 'shop': T + 'Ganesh Stores'}}]}
sm_detail = {'salesman': {'id': 4, 'name': T + 'Ravi Kumar', 'email': 'ravi@soh.test', 'mobile': '9845000009', 'employeeCode': 'SM-01', 'active': True, 'territory': 'Bengaluru South', 'territoryId': 2, 'warehouse': 'Bengaluru DC', 'warehouseId': 3, 'cashLimit': 20000},
  'numbers': sm_list['items'][0]['numbers'], 'retailersRegistered': 6,
  'orders': [{'id': 30, 'order_no': 'SO2611-0001', 'status': 'confirmed', 'grand_total': '1050.00', 'created_at': '2026-11-18 09:40:00', 'business_name': T + 'Ganesh Stores', 'shop_name': None}],
  'visits': [{'id': 1, 'checked_in_at': '2026-11-18 09:30:00', 'outcome': 'order', 'note': None, 'distance_m': 12, 'business_name': T + 'Ganesh Stores', 'shop_name': None, 'city': 'Bengaluru'}],
  'collectionsPending': [{'id': 77, 'receipt_no': 'RC/2627/00077', 'method': 'cash', 'amount': '23500.00', 'reference': None, 'received_at': '2026-11-18 09:45:00', 'order_no': 'SO2611-0001'}],
  'beats': [{'id': 1, 'name': 'Jayanagar', 'weekday': 3, 'is_active': 1, 'territory': 'Bengaluru South', 'stops': [{'seq': 1, 'account_id': 5, 'business_name': T + 'Ganesh Stores', 'shop_name': None, 'city': 'Bengaluru'}]}],
  'targets': [{'period_month': '2026-11', 'metric': 'sales_value', 'target_value': '100000.00'}], 'locations': [{'lat': 12.93, 'lng': 77.58, 'accuracy_m': 15, 'purpose': 'visit', 'note': None, 'captured_at': '2026-11-18 09:30:00'}]}
sm_look = {'staff': [{'id': 10, 'name': T + 'Asha', 'email': 'asha@soh.test', 'mobile': '9845000010', 'hasSalesmanRole': True}], 'territories': [{'id': 2, 'code': 'BLR-S', 'name': 'Bengaluru South', 'level': 'area'}], 'warehouses': [{'id': 3, 'code': 'BLR1', 'name': 'Bengaluru DC'}]}
d_sum = {'day': '2026-11-18', 'byStatus': {'ready': 1, 'dispatched': 2, 'out_for_delivery': 1, 'delivered': 7}, 'open': 4, 'late': 1, 'deliveredToday': 3, 'failedToday': 1, 'waitingForShipment': 2, 'unassignedOwnVehicle': 1,
  'staff': [{'id': 4, 'name': T + 'Ravi (driver)', 'mobile': '9845000004', 'open': 3, 'deliveredToday': 2, 'failed': 1, 'late': 1}]}

results = []
def check(name, ok, *detail):
    results.append(bool(ok)); print('PASS' if ok else 'FAIL', name, *detail)
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])

    # ── 0. the four products: a production server with an empty folder shows them; the cart IDs check out ──
    prods = json.load(urllib.request.urlopen(base + '/api/shop/products'))['products']
    check('four permanent products on an empty production server', sorted(p['slug'] for p in prods) == ['curcumin', 'iron', 'multivitamin', 'probiotic'] and sorted(p['price'] for p in prods) == [576, 581, 621, 626],
          [(p['slug'], p['price']) for p in prods])
    ctx = b.new_context(viewport={'width': 1280, 'height': 860}); pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(base + '/products/iron.html', wait_until='networkidle')
    pg.evaluate("() => localStorage.setItem('soh_cart', JSON.stringify([{id:'iron',name:'Iron Gummies',price:581,qty:1,image:''},{id:'probiotic',name:'Probiotic & Prebiotic Gummies',price:626,qty:2,image:''}]))")
    pg.goto(base + '/checkout/', wait_until='networkidle'); pg.wait_for_timeout(1200)
    body = pg.inner_text('body')
    check('checkout with the product pages\' cart: no "no longer available" error', 'no longer available' not in body and not errs, errs)
    pg.screenshot(path=OUT + '/0-checkout.png', full_page=True)
    pg.goto(base + '/', wait_until='networkidle'); pg.wait_for_timeout(600)
    pg.screenshot(path=OUT + '/0-home.png')
    ctx.close()

    # ── admin pages (ERP answered by fixtures) ──
    for view, vp in [('desktop', {'width': 1360, 'height': 700}), ('mobile', {'width': 390, 'height': 844})]:
        ctx = b.new_context(viewport=vp); pg = ctx.new_page(); errs = []; posts = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        answers = {}
        pg.on('dialog', lambda d: d.accept(answers.get(d.message, 'ok note') if d.type == 'prompt' else None))
        def erp_api(route):
            r = route.request; u = r.url.replace(base, '')
            if r.method != 'GET':
                body = json.loads(r.post_data or '{}') if 'json' in r.headers.get('content-type', '') else {}
                posts.append((r.method, u, body))
                if u == '/api/erp/vendors': return route.fulfill(status=201, json={'vendorId': 9, 'status': 'submitted', 'login': {'userId': 40, 'email': 'new@maker.test', 'temporaryPassword': 'AbCdE-fGhJk-MnPq7', 'mustChangeAtFirstSignIn': True}, 'signInAt': '/login'})
                if u.endswith('/reset-password'): return route.fulfill(json={'userId': 3, 'email': 'kiran@maker.test', 'temporaryPassword': 'ZyXwV-uTsRq-PnMk7', 'mustChangeAtFirstSignIn': True})
                if u == '/api/erp/sales/salesmen': return route.fulfill(status=201, json={'salesmanId': 4})
                return route.fulfill(json={'ok': True})
            if u.startswith('/api/erp/core/me'): return route.fulfill(json=me)
            if u.startswith('/api/erp/vendors-lookup/states'): return route.fulfill(json=states)
            if u.startswith('/api/erp/vendors-lookup/products'): return route.fulfill(json={'items': [{'id': 1, 'sku': 'JAG1', 'name': T + 'Jaggery 1 kg'}]})
            if u.startswith('/api/erp/vendors/8'): return route.fulfill(json=vdetail)
            if u.startswith('/api/erp/vendors'): return route.fulfill(json=vlist)
            if u.startswith('/api/erp/sales/salesmen/lookups'): return route.fulfill(json=sm_look)
            if u.startswith('/api/erp/sales/salesmen/4'): return route.fulfill(json=sm_detail)
            if u.startswith('/api/erp/sales/salesmen'): return route.fulfill(json=sm_list)
            if u.startswith('/api/erp/deliveries/summary'): return route.fulfill(json=d_sum)
            return route.fulfill(json={'items': []})
        pg.route('**/api/erp/**', erp_api)
        pg.route('**/api/platform/nav', lambda route: route.fulfill(json=nav))
        pg.goto(base + '/login'); pg.fill('#email', 'admin@test.local'); pg.fill('#password', 'Test@12345'); pg.click('#submitBtn'); pg.wait_for_url('**/admin/*/*')
        pg.evaluate("t => localStorage.setItem('soh_erp_token', t)", erp_tok)

        if view == 'desktop':
            # admin menu: scroll down, open a page far down, the menu stays where it was
            pg.goto(base + '/admin/overview/dashboard', wait_until='networkidle'); pg.wait_for_timeout(500)
            pg.evaluate("() => { const n = document.getElementById('sbNav'); n.scrollTop = n.scrollHeight; }"); pg.wait_for_timeout(300)
            before = pg.evaluate("() => document.getElementById('sbNav').scrollTop")
            pg.click('#sbNav a.sb-link:has-text("Audit Log")'); pg.wait_for_url('**/admin/administration/audit'); pg.wait_for_timeout(900)
            after = pg.evaluate("() => document.getElementById('sbNav').scrollTop")
            inview = pg.evaluate("() => { const n = document.getElementById('sbNav'), a = n.querySelector('.sb-link.active'); const b = n.getBoundingClientRect(), r = a.getBoundingClientRect(); return r.top >= b.top && r.bottom <= b.bottom; }")
            pg.click('#sbNav a.sb-link:has-text("Shop Settings")'); pg.wait_for_url('**/admin/administration/settings'); pg.wait_for_timeout(900)
            after2 = pg.evaluate("() => document.getElementById('sbNav').scrollTop")
            groups = pg.evaluate("() => Array.from(document.querySelectorAll('#sbNav .sb-group-title')).map(x => x.textContent)")
            dgroup = pg.evaluate("() => { const g = Array.from(document.querySelectorAll('#sbNav .sb-group')).find(x => x.querySelector('.sb-group-title').textContent === 'Delivery'); return g ? Array.from(g.querySelectorAll('.sb-link span')).map(s => s.textContent).filter(Boolean) : null; }")
            pg.screenshot(path=OUT + '/1-menu-keeps-position.png')
            check('admin menu keeps its scroll position', before > 100 and after > 100 and abs(after - before) < 60 and inview and after2 > 100, 'before', before, 'after', after, 'after 2nd click', after2, 'active link visible', inview)
            check('sidebar: Delivery group after Sales', 'Delivery' in groups and groups.index('Delivery') == groups.index('Sales & Orders') + 1 and dgroup == ['Delivery Dashboard', 'Shop Deliveries', 'Trade Deliveries', 'Delivery Staff'], groups, dgroup)

        # Manufacturers & Suppliers
        pg.goto(base + '/admin/procurement/vendors', wait_until='networkidle'); pg.wait_for_timeout(600)
        pg.screenshot(path=OUT + '/%s-2a-suppliers-list.png' % view, full_page=True)
        list_ok = pg.is_visible('text=Waiting for checks') and pg.is_visible('text=kiran@maker.test') and pg.is_visible('text=1 document(s), 1 bank account(s), 1 product(s)')
        pg.click('tr:has-text("Mandya Cane Products") button:has-text("Open")'); pg.wait_for_timeout(700)
        ov_ok = pg.is_visible('#vendorDetail >> text=Manufacturer (own brand) (requested)') and pg.is_visible('text=3 (1 open)') and pg.is_visible('button:has-text("Save changes")')
        pg.screenshot(path=OUT + '/%s-2-supplier-overview.png' % view, full_page=True)
        pg.click('button.ntab:has-text("Sign-ins")'); pg.wait_for_timeout(300)
        pg.click('button:has-text("New temporary password")'); pg.wait_for_timeout(600)
        reset_ok = any(p[1] == '/api/erp/vendors/8/users/3/reset-password' for p in posts) and pg.is_visible('text=ZyXwV-uTsRq-PnMk7')
        vd = pg.locator('#vendorDetail')
        vd.get_by_label('Name', exact=True).fill('Meena'); vd.get_by_label('E-mail', exact=True).fill('meena@maker.test'); vd.get_by_label('Mobile', exact=True).fill('9876500005')
        vd.locator('select[aria-label="Role"]').select_option('dispatch'); vd.locator('button:has-text("Create sign-in")').click(); pg.wait_for_timeout(600)
        up = [p for p in posts if p[1] == '/api/erp/vendors/8/users']
        user_ok = len(up) == 1 and up[0][2] == {'name': 'Meena', 'email': 'meena@maker.test', 'mobile': '9876500005', 'role': 'dispatch'}
        pg.screenshot(path=OUT + '/%s-3-supplier-signins.png' % view, full_page=True)
        pg.click('button.ntab:has-text("Addresses")'); pg.wait_for_timeout(500)
        vd = pg.locator('#vendorDetail')
        vd.locator('select[aria-label="Type"]').select_option('warehouse'); vd.get_by_label('Address line 1').fill('Godown 2'); vd.get_by_label('City').fill('Mysuru')
        vd.locator('select[aria-label="State"]').select_option('12'); vd.get_by_label('PIN code').fill('570001'); vd.locator('button:has-text("Add address")').click(); pg.wait_for_timeout(500)
        ap = [p for p in posts if p[1] == '/api/erp/vendors/8/addresses']
        addr_ok = len(ap) == 1 and ap[0][2]['type'] == 'warehouse' and ap[0][2]['stateId'] == 12 and ap[0][2]['pincode'] == '570001'
        pg.click('button.ntab:has-text("Bank accounts")'); pg.wait_for_timeout(300)
        bank_vis = pg.is_visible('text=XXXX9012')
        pg.click('tr:has-text("XXXX9012") button:has-text("Verify")'); pg.wait_for_timeout(500)
        bank_ok = bank_vis and [p for p in posts if p[1] == '/api/erp/vendors/8/bank-accounts/5/verify'][0][2] == {'status': 'verified'}
        pg.click('button.ntab:has-text("Products & prices")'); pg.wait_for_timeout(300)
        vd.get_by_label('Find our product (SKU or name)').fill('JAG'); vd.get_by_label('Find our product (SKU or name)').press('Tab'); pg.wait_for_timeout(500)
        vd.locator('select[aria-label="Our product"]').select_option('1'); pg.click('tr:has-text("MJ1") button:has-text("Approve")'); pg.wait_for_timeout(500)
        prod = [p for p in posts if p[1] == '/api/erp/vendor-products/11/decide']
        pg.click('tr:has-text("60.00") button:has-text("Accept")'); pg.wait_for_timeout(500)
        price = [p for p in posts if p[1] == '/api/erp/vendor-prices/21/decide']
        prod_ok = len(prod) == 1 and prod[0][2] == {'decision': 'approved', 'productId': 1} and len(price) == 1 and price[0][2]['decision'] == 'accepted'
        pg.screenshot(path=OUT + '/%s-4-supplier-products.png' % view, full_page=True)
        # add a manufacturer with its sign-in
        pg.goto(base + '/admin/procurement/vendors', wait_until='networkidle'); pg.wait_for_timeout(500)
        pg.click('button.ntab:has-text("Add manufacturer / supplier")'); pg.wait_for_timeout(500)
        f = pg.locator('.nbody').first
        f.get_by_label('Legal name *').fill('New Maker Pvt Ltd'); f.get_by_label('GSTIN').fill('29AAACN1234F1Z2')
        f.get_by_label('Manufacturer (own brand)').check(); f.get_by_label('Supplier / wholesaler').uncheck()
        f.get_by_label('Address line 1').fill('Plot 9'); f.get_by_label('City').fill('Hubballi'); f.locator('select[aria-label="State"]').select_option('12'); f.get_by_label('PIN code').fill('580001')
        f.get_by_label("Owner's name *").fill('New Owner'); f.get_by_label("Owner's e-mail * (sign-in name)").fill('new@maker.test'); f.get_by_label("Owner's mobile *").fill('9876500006')
        f.locator('section:has-text("Owner and sign-in") button:has-text("Add")').click(); pg.wait_for_timeout(700)
        cp = [p for p in posts if p[1] == '/api/erp/vendors']
        add_ok = len(cp) == 1 and cp[0][2]['capabilities'] == ['manufacturer'] and cp[0][2]['user'] == {'name': 'New Owner', 'email': 'new@maker.test', 'mobile': '9876500006'} \
            and cp[0][2]['address']['pincode'] == '580001' and pg.is_visible('text=AbCdE-fGhJk-MnPq7') and pg.is_visible('text=must choose their own password first')
        pg.screenshot(path=OUT + '/%s-5-supplier-added.png' % view, full_page=True)
        check(view + ' Manufacturers & Suppliers', list_ok and ov_ok and reset_ok and user_ok and addr_ok and bank_ok and prod_ok and add_ok,
              '| list', list_ok, '| overview', ov_ok, '| reset password', reset_ok, '| add sign-in', user_ok, '| address', addr_ok, '| bank verify', bank_ok, '| product + price', prod_ok, '| add with login', add_ok)

        # Salesmen
        pg.goto(base + '/admin/sales/salesmen', wait_until='networkidle'); pg.wait_for_timeout(700)
        sl_ok = pg.is_visible('text=Cash in hand (not handed over)') and pg.is_visible('text=over limit') and pg.is_visible('text=86%')
        pg.screenshot(path=OUT + '/%s-6-salesmen.png' % view, full_page=True)
        pg.click('tr:has-text("Ravi Kumar") button:has-text("Open")'); pg.wait_for_timeout(700)
        det_ok = pg.is_visible('text=SO2611-0001') and pg.is_visible('text=6 retailers registered')
        pg.click('button.ntab:has-text("Cash to hand over")'); pg.wait_for_timeout(300)
        pg.click('button:has-text("Confirm received")'); pg.wait_for_timeout(500)
        cash_ok = any(p[1] == '/api/erp/sales/collections/77/confirm' for p in posts)
        pg.click('button.ntab:has-text("Settings")'); pg.wait_for_timeout(500)
        pg.get_by_label('Cash limit (₹)').fill('30000'); pg.click('#salesmanDetail button:has-text("Save")'); pg.wait_for_timeout(500)
        put = [p for p in posts if p[0] == 'PUT' and p[1] == '/api/erp/sales/salesmen/4']
        edit_ok = len(put) == 1 and put[0][2]['cashLimit'] == 30000 and put[0][2]['homeTerritoryId'] == 2
        pg.click('button.ntab:has-text("Beats")'); pg.wait_for_timeout(300)
        beat_ok = pg.is_visible('text=Wed · Jayanagar · Bengaluru South')
        pg.screenshot(path=OUT + '/%s-7-salesman-detail.png' % view, full_page=True)
        pg.click('button.ntab:has-text("Add a salesman")'); pg.wait_for_timeout(500)
        pg.select_option('select[aria-label="Staff member"]', '10'); pg.get_by_label('Employee code').fill('SM-02'); pg.select_option('select[aria-label="Home territory"]', '2')
        pg.click('section:has-text("Add a salesman") button:has-text("Add")'); pg.wait_for_timeout(600)
        ad = [p for p in posts if p[1] == '/api/erp/sales/salesmen']
        add_sm_ok = len(ad) == 1 and ad[0][2]['staffId'] == 10 and ad[0][2]['employeeCode'] == 'SM-02' and ad[0][2]['homeTerritoryId'] == 2
        check(view + ' Salesmen', sl_ok and det_ok and cash_ok and edit_ok and beat_ok and add_sm_ok, '| list', sl_ok, '| detail', det_ok, '| cash handover', cash_ok, '| settings', edit_ok, '| beats', beat_ok, '| add', add_sm_ok)

        # Delivery
        pg.goto(base + '/admin/delivery/dashboard', wait_until='networkidle'); pg.wait_for_timeout(900)
        dh_ok = pg.is_visible('text=Online shop') and pg.is_visible('text=Not assigned to a rider') and pg.is_visible('text=Packed, waiting for a shipment') and pg.is_visible('text=Ravi (driver)')
        pg.screenshot(path=OUT + '/%s-8-delivery-dashboard.png' % view, full_page=True)
        pg.goto(base + '/admin/delivery/staff', wait_until='networkidle'); pg.wait_for_timeout(900)
        ds_ok = pg.is_visible('text=Trade delivery staff (field app)') and pg.is_visible('text=Online-shop riders')
        pg.screenshot(path=OUT + '/%s-9-delivery-staff.png' % view, full_page=True)
        pg.goto(base + '/admin/sales/deliveries', wait_until='networkidle'); pg.wait_for_timeout(600)
        shop_ok = pg.url.endswith('/admin/sales/deliveries') and not pg.is_visible('text=Unknown screen')
        check(view + ' Delivery', dh_ok and ds_ok and shop_ok and not errs, '| dashboard', dh_ok, '| staff', ds_ok, '| shop deliveries page', shop_ok, '| page errors', errs)
        ctx.close()

    # ── supplier portal: registration and the team ──
    ctx = b.new_context(viewport={'width': 390, 'height': 844}); pg = ctx.new_page(); errs = []; vposts = []
    pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('dialog', lambda d: d.accept())
    mev = {'user': {'id': 3, 'name': 'Kiran', 'email': 'kiran@maker.test', 'mobile': '9876500001', 'role': 'owner'}, 'vendor': {'id': 8, 'legal_name': T + 'Mandya Cane Products', 'status': 'submitted', 'gstin': '29AAACM1234F1Z5'},
           'capabilities': [{'capability': 'contract_manufacturer', 'status': 'requested'}], 'documents': [], 'addresses': [], 'bankAccounts': [],
           'users': [{'id': 3, 'name': 'Kiran', 'email': 'kiran@maker.test', 'mobile': '9876500001', 'role': 'owner', 'status': 'active', 'lastLoginAt': None}]}
    def vapi(route):
        r = route.request; u = r.url.replace(base, '')
        if r.method != 'GET':
            vposts.append((u, json.loads(r.post_data or '{}') if 'json' in r.headers.get('content-type', '') else 'multipart'))
            if u == '/api/vendor/users': return route.fulfill(status=201, json={'userId': 41, 'email': 'raju@maker.test', 'temporaryPassword': 'QwErT-yUiPa-SdFg7', 'mustChangeAtFirstSignIn': True})
            return route.fulfill(status=201, json={'vendorId': 8, 'status': 'submitted'})
        if u.startswith('/api/vendor/states'): return route.fulfill(json={'states': states['items']})
        if u == '/api/vendor/me': return route.fulfill(json=mev)
        return route.fulfill(json={'items': []})
    pg.route('**/api/vendor/**', vapi)
    pg.goto(base + '/vendor-portal/?register', wait_until='networkidle'); pg.wait_for_timeout(500)
    pg.get_by_label('Legal name (as on GST) *').fill('Raju Foods'); pg.get_by_label('Supplier / wholesaler').check(); pg.get_by_label('Authorised distributor').check()
    pg.get_by_label('Address *').fill('Shop 3, APMC Yard'); pg.get_by_label('City *').fill('Hubballi'); pg.select_option('select[aria-label="State *"]', '12'); pg.get_by_label('PIN code *').fill('580029')
    pg.get_by_label('Your name *').fill('Raju'); pg.get_by_label('E-mail * (you sign in with this)').fill('raju@foods.test'); pg.get_by_label('Mobile *').fill('9876500007'); pg.get_by_label('Password * (12+ characters, letters and a number)').fill('Raju-pass-12345')
    pg.screenshot(path=OUT + '/portal-1-register.png', full_page=True)
    pg.click('button:has-text("Register")'); pg.wait_for_timeout(700)
    rg = [p for p in vposts if p[0] == '/api/vendor/register']
    reg_ok = len(rg) == 1 and sorted(rg[0][1]['capabilities']) == ['authorised_distributor', 'supplier_wholesaler'] and rg[0][1]['address'] == {'type': 'registered', 'line1': 'Shop 3, APMC Yard', 'city': 'Hubballi', 'pincode': '580029', 'stateId': 12} \
        and rg[0][1]['legalName'] == 'Raju Foods' and rg[0][1]['user']['email'] == 'raju@foods.test' and pg.is_visible('text=Registered. Sign in to upload')
    pg.evaluate("() => sessionStorage.setItem('vendor.token', 'fixture-token')")
    pg.goto(base + '/vendor-portal/', wait_until='networkidle'); pg.wait_for_timeout(700)
    home_ok = pg.is_visible('text=Your team (who can sign in)') and pg.is_visible('text=Bank accounts') and pg.is_visible('h2:has-text("Addresses")')
    sec = pg.locator('section:has-text("Your team")')
    sec.get_by_label('Name', exact=True).fill('Raju'); sec.get_by_label('E-mail', exact=True).fill('raju@maker.test'); sec.get_by_label('Mobile', exact=True).fill('9876500008')
    sec.locator('select[aria-label="Role"]').select_option('sales'); sec.locator('button:has-text("Add a sign-in")').click(); pg.wait_for_timeout(600)
    tm = [p for p in vposts if p[0] == '/api/vendor/users']
    team_ok = len(tm) == 1 and tm[0][1]['role'] == 'sales' and pg.is_visible('text=QwErT-yUiPa-SdFg7')
    bk = pg.locator('section:has-text("We pay only into")')
    bk.get_by_label('Account holder name').fill('Mandya Cane'); bk.get_by_label('Account number').fill('123456789012'); bk.get_by_label('IFSC').fill('HDFC0001234'); bk.locator('button:has-text("Add account")').click(); pg.wait_for_timeout(500)
    bank_ok = [p for p in vposts if p[0] == '/api/vendor/bank-accounts'] == [('/api/vendor/bank-accounts', {'accountName': 'Mandya Cane', 'accountNo': '123456789012', 'ifsc': 'HDFC0001234'})]
    pg.screenshot(path=OUT + '/portal-2-home.png', full_page=True)
    check('supplier portal | registration', reg_ok, '| home sections', home_ok, '| team sign-in', team_ok, '| bank account', bank_ok, '| errors', errs)
    results[-1] = reg_ok and home_ok and team_ok and bank_ok and not errs
    ctx.close()

    # ── /login: partner links ──
    ctx = b.new_context(viewport={'width': 390, 'height': 844}); pg = ctx.new_page()
    pg.goto(base + '/login', wait_until='networkidle')
    check('sign-in page links to manufacturer/supplier and retailer registration', pg.locator('a[href="/vendor-portal/?register"]').count() == 1 and pg.locator('a[href="/b2b/"]').count() == 1)
    pg.screenshot(path=OUT + '/login.png', full_page=True); ctx.close()

    # ── field app: the salesman's "My day" ──
    ctx = b.new_context(viewport={'width': 390, 'height': 844}); pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    dash = {'month': '2026-11', 'today': {'orders': 2, 'value': 4200, 'visits': 5, 'collected': 3000}, 'monthToDate': {'sales_value': 86000, 'orders': 31, 'collections': 52000, 'visits': 88},
            'target': {'sales_value': 100000, 'visits': 120}, 'achievementPct': {'sales_value': 86, 'visits': 73.3}, 'cashInHand': 23500, 'cashLimit': 20000, 'overCashLimit': True,
            'beatsToday': [{'id': 1, 'name': 'Jayanagar', 'done': 1, 'stops': [{'seq': 1, 'accountId': 5, 'shop': T + 'Ganesh Stores', 'city': 'Bengaluru', 'mobile': '9845011111', 'visitedAt': '2026-11-18 09:30:00'},
                                                                                {'seq': 2, 'accountId': 6, 'shop': T + 'Lakshmi Medicals', 'city': 'Bengaluru', 'mobile': None, 'visitedAt': None}]}],
            'recentOrders': [{'id': 30, 'orderNo': 'SO2611-0001', 'status': 'confirmed', 'value': 1050, 'at': '2026-11-18 09:40:00', 'shop': T + 'Ganesh Stores'}]}
    def field(route):
        u = route.request.url.replace(base, '')
        if u.startswith('/api/sales/me'): return route.fulfill(json={'salesman': {'id': 4, 'employeeCode': 'SM-01', 'name': T + 'Ravi Kumar', 'cashLimit': '20000.00'}, 'beatsToday': [], 'targets': [], 'cashInHand': '23500.00', 'otpOrdering': 'enabled'})
        if u.startswith('/api/sales/dashboard'): return route.fulfill(json=dash)
        if u.startswith('/api/sales/retailers'): return route.fulfill(json={'items': []})
        if u.startswith('/api/erp/events'): return route.fulfill(status=403, json={'error': 'no'})
        if u.startswith('/api/erp/deliveries'): return route.fulfill(status=403, json={'error': 'no'})
        return route.fulfill(json={})
    pg.route('**/api/sales/**', field); pg.route('**/api/erp/**', field)
    pg.goto(base + '/sales-app/', wait_until='networkidle'); pg.evaluate("t => sessionStorage.setItem('sales.token', t)", erp_tok)
    pg.goto(base + '/sales-app/', wait_until='networkidle'); pg.wait_for_timeout(900)
    fd_ok = pg.is_visible('text=My day') and pg.is_visible('text=₹86,000 of ₹1,00,000 (86%)') and pg.is_visible("text=Today's beat: Jayanagar — 1 of 2 shops visited") and pg.is_visible('text=more cash than your limit')
    pg.screenshot(path=OUT + '/field-1-my-day.png', full_page=True)
    check('field app | salesman dashboard', fd_ok and not errs, errs)
    ctx.close()
    b.close()
finally:
    srv.terminate()
print('ALL PASS' if results and all(results) else 'SOME FAILED', results)
