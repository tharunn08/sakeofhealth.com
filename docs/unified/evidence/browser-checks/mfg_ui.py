"""Manufacturing and delivery screens — BROWSER CHECK OF THE SCREENS ONLY.
Admin (Manufacturers, Manufacturing orders, Batch quality & release, Bills of materials, Trade deliveries),
the manufacturer's workspace in the supplier portal, the retailer portal's shipment card and challan,
and the field app's "My deliveries" (offline → queued → sent once).
The real server runs (B2B + ERP enabled, business database unreachable). Every business API call is
answered by labelled TEST FIXTURES below; this proves what the screens send and show, not the business
results (those are in the MySQL 8 suites)."""
import json, os, subprocess, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright
ROOT = os.environ.get('SOH_ROOT', '/home/claude/dev/soh'); OUT = '/home/claude/dev/checks/mfg'; os.makedirs(OUT, exist_ok=True)
FIX = json.load(open('/home/claude/dev/checks/erp-fixture.json'))
ERP_SECRET = 'unit-test-erp-secret-0123456789abcdef'
env = dict(os.environ, PORT='5196', NODE_ENV='test', DATA_DIR=tempfile.mkdtemp(), B2B_PRIVATE_DIR=tempfile.mkdtemp(), PAYMENT_MOCK='true', AUTO_SEED='true',
  ADMIN_EMAIL='admin@test.local', ADMIN_PASSWORD='Test@12345', B2B_ENABLED='true', ERP_ENABLED='true', B2B_JWT_SECRET='test-b2b-secret-not-for-production-123',
  ERP_JWT_SECRET=ERP_SECRET, DB_HOST='127.0.0.1', DB_PORT='1', DB_USER='nobody', DB_PASSWORD='x', DB_NAME='nothing',
  ADMIN_JWT_SECRET='test-admin-secret-0123456789-abcdefghijklmnopqrstuvwxyz', CUSTOMER_JWT_SECRET='test-customer-secret-0123456789-abcdefghijklmnopqrstuv', RAZORPAY_KEY_ID='', SMTP_HOST='')
srv = subprocess.Popen(['node', 'index.js'], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
base = 'http://127.0.0.1:5196'
for _ in range(100):
    try: urllib.request.urlopen(base + '/health'); break
    except Exception: time.sleep(0.15)
erp_tok = subprocess.run(['node', '-e', "process.env.ERP_JWT_SECRET='%s';process.stdout.write(require('./src/modules/erp/core/security.js').sign({sid:1,tv:0,mfa:true,ses:'check'}))" % ERP_SECRET], cwd=ROOT, capture_output=True, text=True, env=dict(env)).stdout

NEW = ['manufacturing.view', 'manufacturing.manage', 'manufacturing.bom.approve', 'manufacturing.issue', 'manufacturing.qc.release', 'deliveries.view', 'deliveries.manage', 'deliveries.update']
perms = FIX['perms'] + NEW
nav = json.loads(json.dumps(FIX['nav']))
def item(i, label, path, icon, view): return {'id': i, 'label': label, 'path': path, 'icon': icon, 'badge': None, 'module': 'erp', 'view': view}
mgroup = {'id': 'manufacturing', 'label': 'Manufacturing & Quality', 'items': [item('erp-manufacturers', 'Manufacturers', '/admin/manufacturing/manufacturers', 'store', 'manufacturers'),
  item('erp-manufacturing', 'Manufacturing Orders', '/admin/manufacturing/orders', 'box', 'manufacturing'), item('erp-quality', 'Batch Quality & Release', '/admin/manufacturing/quality', 'check', 'quality'),
  item('erp-boms', 'Bills of Materials', '/admin/manufacturing/boms', 'reports', 'boms')]}
idx = [i for i, g in enumerate(nav['groups']) if g['id'] == 'inventory'][0]
nav['groups'].insert(idx + 1, mgroup)
for g in nav['groups']:
    if any(i['path'].startswith('/admin/sales/') for i in g['items']):
        g['items'].insert(1, item('erp-deliveries', 'Trade Deliveries', '/admin/sales/trade-deliveries', 'truck', 'deliveries'))
me = {'id': 1, 'name': 'UI Check', 'email': 'ui@check.local', 'roles': ['super_admin'], 'permissions': perms, 'scopes': {'territory': 'all', 'warehouse': 'all', 'state': 'all'}, 'mfa': True}
T = '(TEST FIXTURE) '
look = {'products': [{'id': 1, 'sku': 'JAG1', 'name': T + 'Jaggery 1 kg', 'kind': 'finished', 'uom': 'pcs'}, {'id': 2, 'sku': 'CANE', 'name': T + 'Cane concentrate', 'kind': 'raw_material', 'uom': 'kg'}],
        'warehouses': [{'id': 3, 'code': 'BLR1', 'name': 'Bengaluru DC'}], 'manufacturers': [{'id': 8, 'name': T + 'Mandya Cane Products'}], 'facilities': [{'id': 4, 'vendorId': 8, 'name': 'Mandya plant'}],
        'activeBoms': [{'id': 5, 'productId': 1, 'version': 2}], 'purchaseOrders': [{'id': 9, 'poNo': 'PO/2627/00009', 'vendorId': 8, 'status': 'accepted', 'warehouseId': 3}]}
makers = {'items': [{'id': 8, 'code': 'V00008', 'name': T + 'Mandya Cane Products', 'tradeName': None, 'gstin': '29AAACM1234F1Z5', 'fssai': '10019043000123', 'fssaiValidTo': '2027-12-31', 'fssaiExpired': False, 'status': 'approved',
          'capabilities': [{'capability': 'contract_manufacturer', 'status': 'approved'}], 'facilities': 1, 'productsApproved': 2, 'productsPending': 1, 'openOrders': 1, 'batchesWaiting': 1, 'lateDeliveries': 1}]}
mdetail = {'manufacturer': {'id': 8, 'vendor_code': 'V00008', 'legal_name': T + 'Mandya Cane Products', 'gstin': '29AAACM1234F1Z5', 'pan': 'AAACM1234F', 'fssai_licence': '10019043000123', 'fssai_valid_to': '2027-12-31', 'fssaiExpired': False, 'status': 'approved'},
           'capabilities': [{'capability': 'contract_manufacturer', 'status': 'approved'}], 'contact': {'name': 'Kiran', 'email': 'kiran@maker.test', 'mobile': '9876500001'},
           'facilities': [{'id': 4, 'name': 'Mandya plant', 'address': 'KIADB', 'city': 'Mandya', 'pincode': '571401', 'fssai': '10019043000123', 'fssaiValidTo': '2027-12-31', 'capacityPerMonth': 5000, 'capacityUom': 'kg', 'status': 'active'}],
           'documents': [], 'products': [{'id': 1, 'name': T + 'Jaggery', 'vendor_sku': 'MJ1', 'sku': 'JAG1', 'hsn_code': '1701', 'mrp': '120.00', 'shelf_life_days': 365, 'lead_days': 10, 'status': 'approved'}],
           'approvedProducts': 1, 'pendingProducts': 0, 'priceLists': [], 'purchaseOrders': [], 'deliveries': [{'id': 1, 'deliveryNoteNo': 'DN-1', 'poNo': 'PO/2627/00009', 'transporter': 'KSRTC', 'lrNo': 'LR-7', 'ewayBillNo': None, 'dispatchedAt': '2026-11-15T10:00:00Z', 'expectedAt': '2026-11-16T10:00:00Z', 'receivedAt': None, 'status': 'dispatched', 'late': True, 'lateHours': 30}],
           'manufacturingOrders': [], 'batches': [], 'rejectedBatches': 0,
           'performance': {'purchaseOrders': 3, 'purchaseValue': 18900, 'fillRatePct': 96.5, 'receiptRejectPct': 1.2, 'receipts': 3, 'onTimePct': 66.7, 'avgLeadDays': 9.5, 'batchesReleased': 4, 'batchesRejected': 1, 'batchesWaiting': 1, 'unitsRejectedAtQc': 10, 'lateDeliveries': 1}}
mo = {'id': 21, 'moNo': 'MO/2627/00007', 'mode': 'in_house', 'vendor': None, 'facility': None, 'sku': 'JAG1', 'product': T + 'Jaggery 1 kg', 'warehouse': 'BLR1', 'warehouseId': 3, 'poNo': None, 'plannedQty': 100, 'producedQty': 0, 'releasedQty': 0, 'rejectedQty': 0,
      'plannedEnd': '2026-11-30', 'late': False, 'status': 'draft', 'bom': {'id': 5, 'version': 2, 'outputQty': 100}, 'materials': [{'productId': 2, 'sku': 'CANE', 'name': T + 'Cane concentrate', 'uom': 'kg', 'required': 110, 'issued': 0}],
      'issues': [], 'batches': [], 'documents': [], 'events': [{'kind': 'status', 'stage': 'draft', 'qty': None, 'note': 'Created', 'by': 'ui@check.local', 'at': '2026-11-18T10:00:00Z'}]}
batches = {'items': [{'id': 31, 'moId': 21, 'moNo': 'MO/2627/00006', 'mode': 'contract', 'vendor': T + 'Mandya Cane Products', 'sku': 'JAG1', 'product': T + 'Jaggery 1 kg', 'batchNo': 'CM-1', 'mfgDate': '2026-11-15', 'expiryDate': '2027-11-15', 'qty': 60, 'status': 'submitted', 'releasedQty': 0, 'rejectedQty': 0, 'hasCoa': True, 'qcNote': None}]}
boms = {'items': [{'id': 6, 'productId': 1, 'sku': 'JAG1', 'name': T + 'Jaggery 1 kg', 'version': 3, 'outputQty': 100, 'status': 'draft', 'lines': 2, 'approvedAt': None}]}
ship = {'id': 70, 'shipmentNo': 'SHP/2627/00001', 'orderId': 30, 'orderNo': 'SO2611-0001', 'orderStatus': 'packed', 'status': 'ready', 'mode': 'own_vehicle', 'carrier': None, 'vehicleNo': 'KA01AB1234', 'driverName': None, 'driverPhone': None,
        'trackingNo': None, 'lrNo': None, 'ewayBillNo': None, 'packages': 2, 'weightKg': 20, 'expectedAt': '2026-11-19T10:00:00Z', 'attempts': 0, 'challanNo': None, 'receivedBy': None, 'hasProof': False, 'late': False, 'deliveryStaffId': 4, 'deliveryStaff': T + 'Ravi (driver)',
        'buyer': T + 'Ganesh Stores', 'value': 1050, 'address': {'name': 'Ganesh Stores', 'contact': 'Owner', 'phone': '9845011111', 'line1': 'MG Road', 'city': 'Bengaluru', 'state': 'Karnataka', 'pincode': '560001', 'lat': 12.97, 'lng': 77.59},
        'missing': [], 'events': [{'kind': 'created', 'note': 'Shipment SHP/2627/00001', 'place': None, 'lat': None, 'lng': None, 'by': 'ui@check.local', 'at': '2026-11-18T10:00:00Z'}],
        'items': [{'id': 1, 'sku': 'JAG1', 'name': T + 'Jaggery 1 kg', 'qty': 10, 'delivered': None}], 'canManage': True, 'maxAttempts': None}
deliv = {'items': [ship], 'toShip': [{'orderId': 31, 'orderNo': 'SO2611-0002', 'packedAt': '2026-11-18T09:00:00Z', 'value': 525, 'units': 5, 'city': 'Bengaluru', 'pincode': '560001', 'buyer': T + 'Ganesh Stores', 'sellerType': 'company', 'warehouse': 'BLR1'}]}

results = []
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    for view, vp in [('desktop', {'width': 1360, 'height': 900}), ('mobile', {'width': 390, 'height': 844})]:
        ctx = b.new_context(viewport=vp); pg = ctx.new_page(); errs = []; posts = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        answers = {'Stage (e.g. mixing, filling, packing)': 'filling', 'What did QC find? (a short note)': 'CoA within spec'}
        pg.on('dialog', lambda d: d.accept(answers.get(d.message, '') if d.type == 'prompt' else None))
        def erp_api(route):
            r = route.request; u = r.url.replace(base, '')
            if r.method != 'GET':
                ct = r.headers.get('content-type', '')
                body = json.loads(r.post_data or '{}') if 'json' in ct else {'_multipart': True, '_raw': (r.post_data_buffer or b'')[:4000].decode('latin1')}
                posts.append((u, body)); time.sleep(0.2)
                if u.endswith('/release'): return route.fulfill(json={'id': 21, 'status': 'released'})
                if u.endswith('/qc'): return route.fulfill(json={'batchId': 31, 'status': 'released', 'releasedQty': 60, 'rejectedQty': 0})
                if u.endswith('/dispatch'): return route.fulfill(json={'id': 70, 'status': 'dispatched', 'challanNo': 'DC/2627/00001', 'invoiceNo': None, 'warnings': []})
                if u.endswith('/delivered'): return route.fulfill(json={'id': 70, 'status': 'delivered', 'invoiceNo': 'INV/2627/00001', 'creditNote': None})
                if u.endswith('/api/erp/deliveries/'): return route.fulfill(status=201, json={'id': 71, 'shipmentNo': 'SHP/2627/00002', 'status': 'ready'})
                return route.fulfill(json={'ok': True})
            if u.startswith('/api/erp/core/me'): return route.fulfill(json=me)
            if u.startswith('/api/erp/manufacturing/lookups'): return route.fulfill(json=look)
            if u.startswith('/api/erp/manufacturing/manufacturers/8'): return route.fulfill(json=mdetail)
            if u.startswith('/api/erp/manufacturing/manufacturers'): return route.fulfill(json=makers)
            if u.startswith('/api/erp/manufacturing/orders/21'): return route.fulfill(json=mo)
            if u.startswith('/api/erp/manufacturing/orders'): return route.fulfill(json={'items': [{k: mo[k] for k in ['id', 'moNo', 'mode', 'vendor', 'facility', 'sku', 'product', 'plannedQty', 'producedQty', 'releasedQty', 'rejectedQty', 'plannedEnd', 'late', 'status']}]})
            if u.startswith('/api/erp/manufacturing/batches'): return route.fulfill(json=batches)
            if u.startswith('/api/erp/manufacturing/boms'): return route.fulfill(json=boms)
            if u.startswith('/api/erp/manufacturing/'): return route.fulfill(json={'items': []})
            if u.startswith('/api/erp/deliveries/staff'): return route.fulfill(json={'items': [{'id': 4, 'name': T + 'Ravi (driver)', 'mobile': '9845000004'}]})
            if u.startswith('/api/erp/deliveries/70'): return route.fulfill(json=ship)
            if u.startswith('/api/erp/deliveries'): return route.fulfill(json=deliv)
            return route.fulfill(json={'items': []})
        pg.route('**/api/erp/**', erp_api)
        pg.route('**/api/platform/nav', lambda route: route.fulfill(json=nav))
        pg.goto(base + '/login'); pg.fill('#email', 'admin@test.local'); pg.fill('#password', 'Test@12345'); pg.click('#submitBtn'); pg.wait_for_url('**/admin/*/*')
        pg.evaluate("t => localStorage.setItem('soh_erp_token', t)", erp_tok)
        # manufacturers: list → detail with performance and late delivery
        pg.goto(base + '/admin/manufacturing/manufacturers', wait_until='networkidle'); pg.wait_for_timeout(400)
        nav_ok = pg.is_visible('text=Manufacturing & Quality') or view == 'mobile'
        pg.click('button:has-text("Open")'); pg.wait_for_timeout(500)
        makers_ok = pg.is_visible('text=On-time deliveries') and pg.is_visible('text=66.7%') and pg.is_visible('text=LATE 30 h') and pg.is_visible('text=Mandya plant')
        pg.screenshot(path='%s/%s-1-manufacturers.png' % (OUT, view), full_page=True)
        # manufacturing order: open, release, materials table, post an update
        pg.goto(base + '/admin/manufacturing/orders', wait_until='networkidle'); pg.wait_for_timeout(400)
        pg.click('tr:has-text("MO/2627/00007") button:has-text("Open")'); pg.wait_for_timeout(500)
        mat_ok = pg.is_visible('text=Materials (bill of materials v2: 100 units)')
        pg.click('button:has-text("Release")'); pg.wait_for_timeout(500)
        release_ok = len([p for p in posts if p[0] == '/api/erp/manufacturing/orders/21/release']) == 1
        pg.screenshot(path='%s/%s-2-manufacturing-order.png' % (OUT, view), full_page=True)
        # the "new order" form: contract shows manufacturer + PO; in-house shows the BOM note
        pg.click('button.ntab:has-text("New order")'); pg.wait_for_timeout(500)
        pg.select_option('select[aria-label="Type"]', 'in_house'); pg.select_option('select[aria-label="Product"]', '1'); pg.wait_for_timeout(200)
        form_ok = pg.is_visible('text=Uses bill of materials version 2.') and not pg.is_visible('select[aria-label="Manufacturer"]')
        pg.fill('input[aria-label="Planned quantity"]', '100'); pg.select_option('select[aria-label="Warehouse"]', '3')
        pg.click('button:has-text("Create order")'); pg.wait_for_timeout(500)
        cp = [p for p in posts if p[0] == '/api/erp/manufacturing/orders']
        create_ok = len(cp) == 1 and cp[0][1]['mode'] == 'in_house' and cp[0][1]['productId'] == 1 and cp[0][1]['plannedQty'] == 100 and 'vendorId' not in cp[0][1]
        # quality: release sends one decision with the note
        pg.goto(base + '/admin/manufacturing/quality', wait_until='networkidle'); pg.wait_for_timeout(400)
        pg.click('button:has-text("Release")'); pg.wait_for_timeout(600)
        qc = [p for p in posts if p[0] == '/api/erp/manufacturing/batches/31/qc']
        qc_ok = len(qc) == 1 and qc[0][1] == {'result': 'pass', 'note': 'CoA within spec'}
        pg.screenshot(path='%s/%s-3-quality.png' % (OUT, view), full_page=True)
        # bills of materials: list with Activate for a draft
        pg.goto(base + '/admin/manufacturing/boms', wait_until='networkidle'); pg.wait_for_timeout(400)
        bom_ok = pg.is_visible('button:has-text("Activate")') and pg.is_visible('text=New bill of materials (draft)')
        pg.screenshot(path='%s/%s-4-boms.png' % (OUT, view), full_page=True)
        # trade deliveries: create a shipment for a packed order; open one; dispatch; proof of delivery
        pg.goto(base + '/admin/sales/trade-deliveries', wait_until='networkidle'); pg.wait_for_timeout(400)
        pg.click('button.ntab:has-text("To ship")'); pg.wait_for_timeout(400)
        pg.click('button:has-text("Create shipment")'); pg.wait_for_timeout(500)
        pg.fill('input[aria-label="Vehicle number"]', 'KA01AB1234'); pg.select_option('select[aria-label="Our delivery staff"]', '4')
        pg.click('section button:has-text("Create shipment")'); pg.wait_for_timeout(600)
        cs = [p for p in posts if p[0] == '/api/erp/deliveries/']
        ship_ok = len(cs) == 1 and cs[0][1]['orderId'] == 31 and cs[0][1]['mode'] == 'own_vehicle' and cs[0][1]['vehicleNo'] == 'KA01AB1234' and cs[0][1]['deliveryStaffId'] == 4
        pg.goto(base + '/admin/sales/trade-deliveries', wait_until='networkidle'); pg.wait_for_timeout(400)
        pg.click('tr:has-text("SHP/2627/00001") button:has-text("Open")'); pg.wait_for_timeout(500)
        pg.click('button:has-text("Dispatch")'); pg.wait_for_timeout(600)
        disp_ok = len([p for p in posts if p[0] == '/api/erp/deliveries/70/dispatch']) == 1 and pg.is_visible('text=Challan DC/2627/00001')
        pg.screenshot(path='%s/%s-5-deliveries.png' % (OUT, view), full_page=True)
        results.append(nav_ok and makers_ok and mat_ok and release_ok and form_ok and create_ok and qc_ok and bom_ok and ship_ok and disp_ok and not errs)
        print('PASS' if results[-1] else 'FAIL', view, '| sidebar group', nav_ok, '| manufacturer detail', makers_ok, '| materials', mat_ok, '| release once', release_ok, '| new-order form', form_ok, create_ok,
              '| QC decision', qc_ok, '| BOM screen', bom_ok, '| create shipment', ship_ok, '| dispatch + challan', disp_ok, '| page errors', errs)
        ctx.close()

    # ── proof of delivery from the admin (multipart: who received it, quantities) ──
    ctx = b.new_context(viewport={'width': 1360, 'height': 900}); pg = ctx.new_page(); errs = []; posts = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    moving = dict(ship, status='out_for_delivery', orderStatus='out_for_delivery', challanNo='DC/2627/00001')
    def erp2(route):
        r = route.request; u = r.url.replace(base, '')
        if r.method != 'GET':
            posts.append((u, (r.post_data_buffer or b'').decode('latin1'))); return route.fulfill(json={'id': 70, 'status': 'partially_delivered', 'invoiceNo': 'INV/2627/00001', 'creditNote': {'creditNoteNo': 'CN/2627/00001'}})
        if u.startswith('/api/erp/core/me'): return route.fulfill(json=me)
        if u.startswith('/api/erp/deliveries/70'): return route.fulfill(json=moving)
        if u.startswith('/api/erp/deliveries/staff'): return route.fulfill(json={'items': []})
        if u.startswith('/api/erp/deliveries'): return route.fulfill(json={'items': [moving], 'toShip': []})
        return route.fulfill(json={'items': []})
    pg.route('**/api/erp/**', erp2); pg.route('**/api/platform/nav', lambda route: route.fulfill(json=nav))
    pg.goto(base + '/login'); pg.fill('#email', 'admin@test.local'); pg.fill('#password', 'Test@12345'); pg.click('#submitBtn'); pg.wait_for_url('**/admin/*/*')
    pg.evaluate("t => localStorage.setItem('soh_erp_token', t)", erp_tok)
    pg.goto(base + '/admin/sales/trade-deliveries', wait_until='networkidle'); pg.wait_for_timeout(400)
    pg.click('tr:has-text("SHP/2627/00001") button:has-text("Open")'); pg.wait_for_timeout(500)
    pg.click('button:has-text("Delivered…")'); pg.wait_for_timeout(400)
    pg.fill('input[aria-label="Received by"]', 'Ganesh'); pg.fill('input[aria-label="Delivered ' + T + 'Jaggery 1 kg"]', '8')
    pg.click('button:has-text("Confirm delivery")'); pg.wait_for_timeout(600)
    pd = [p for p in posts if p[0] == '/api/erp/deliveries/70/delivered']
    pod_ok = len(pd) == 1 and 'name="receivedBy"' in pd[0][1] and 'Ganesh' in pd[0][1] and '{"1":8}' in pd[0][1] and pg.is_visible('text=credit note CN/2627/00001')
    pg.screenshot(path='%s/desktop-6-proof-of-delivery.png' % OUT, full_page=True)
    results.append(pod_ok and not errs)
    print('PASS' if results[-1] else 'FAIL', 'proof of delivery | multipart with receiver and quantities', pod_ok, '| errors', errs)
    ctx.close()

    # ── manufacturer workspace (supplier portal) ──
    ctx = b.new_context(viewport={'width': 390, 'height': 844}); pg = ctx.new_page(); errs = []; vposts = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('dialog', lambda d: d.accept())
    vmo = {'id': 21, 'moNo': 'MO/2627/00006', 'mode': 'contract', 'sku': 'JAG1', 'product': T + 'Jaggery 1 kg', 'plannedQty': 100, 'producedQty': 0, 'releasedQty': 0, 'rejectedQty': 0, 'plannedEnd': '2026-11-30', 'status': 'released', 'poNo': 'PO/2627/00009',
           'batches': [], 'documents': [], 'events': [{'kind': 'status', 'stage': 'released', 'qty': None, 'note': 'Released', 'by': 'Sake of Health', 'at': '2026-11-18T10:00:00Z'}]}
    def vapi(route):
        r = route.request; u = r.url.replace(base, '')
        if r.method != 'GET':
            vposts.append((u, json.loads(r.post_data or '{}') if 'json' in r.headers.get('content-type', '') else 'multipart'))
            if u.endswith('/respond'): vmo['status'] = 'accepted'
            return route.fulfill(status=201 if u.endswith('/batches') else 200, json={'id': 21, 'status': vmo['status'], 'batchId': 31})
        if u == '/api/vendor/me': return route.fulfill(json={'user': {'id': 3, 'name': 'Kiran', 'email': 'kiran@maker.test', 'role': 'owner'}, 'vendor': {'id': 8, 'legal_name': T + 'Mandya Cane Products', 'status': 'approved'},
                                                            'capabilities': [{'capability': 'contract_manufacturer', 'status': 'approved'}], 'documents': []})
        if u.startswith('/api/vendor/manufacturing-orders/21'): return route.fulfill(json=vmo)
        if u.startswith('/api/vendor/manufacturing-orders'): return route.fulfill(json={'items': [vmo]})
        if u.startswith('/api/vendor/deliveries'): return route.fulfill(json={'items': [{'id': 1, 'deliveryNoteNo': 'DN-1', 'poNo': 'PO/2627/00009', 'transporter': 'KSRTC', 'lrNo': 'LR-7', 'dispatchedAt': '2026-11-15T10:00:00Z', 'expectedAt': '2026-11-16T10:00:00Z', 'receivedAt': None, 'status': 'dispatched', 'late': True, 'lateHours': 30}]})
        if u.startswith('/api/vendor/products'): return route.fulfill(json={'items': [{'id': 11, 'name': T + 'Jaggery 1 kg', 'vendorSku': 'MJ1', 'mrp': 120, 'status': 'approved', 'reviewNote': None, 'lastPrice': {'unitPrice': 60, 'gstRate': 5, 'status': 'accepted', 'validFrom': '2026-11-01'}}]})
        if u.startswith('/api/vendor/accounts'): return route.fulfill(json={'invoices': [{'invoiceNo': 'MCP/101', 'date': '2026-11-10', 'poNo': 'PO/2627/00009', 'total': 6300, 'paid': 3000, 'outstanding': 3300, 'dueDate': '2026-12-10', 'status': 'matched'}], 'payments': []})
        return route.fulfill(json={'items': []})
    pg.route('**/api/vendor/**', vapi)
    pg.goto(base + '/vendor-portal/', wait_until='networkidle'); pg.evaluate("() => sessionStorage.setItem('vendor.token', 'fixture-token')")
    pg.goto(base + '/vendor-portal/', wait_until='networkidle'); pg.wait_for_timeout(600)
    ws_ok = pg.is_visible('text=Manufacturing orders') and pg.is_visible('text=LATE by 30 h') and pg.is_visible('text=MCP/101')
    pg.locator('section:has-text("Manufacturing orders") button:has-text("Open")').first.click(); pg.wait_for_timeout(500)
    pg.click('button:has-text("Accept order")'); pg.wait_for_timeout(600)
    accept_ok = [p for p in vposts if p[0].endswith('/respond')] == [('/api/vendor/manufacturing-orders/21/respond', {'response': 'accepted'})]
    pg.get_by_label('Batch number').fill('CM-1'); pg.get_by_label('Manufactured on').fill('2026-11-15'); pg.get_by_label('Expiry', exact=True).fill('2027-11-15'); pg.get_by_label('Quantity', exact=True).fill('60')
    pg.set_input_files('input[aria-label="Certificate of Analysis"]', {'name': 'coa.pdf', 'mimeType': 'application/pdf', 'buffer': b'%PDF-1.4 test fixture'})
    pg.click('button:has-text("Record batch")'); pg.wait_for_timeout(700)
    bp = [p for p in vposts if p[0].endswith('/batches')]; dp = [p for p in vposts if p[0].endswith('/documents')]
    batch_ok = len(bp) == 1 and bp[0][1] == {'batchNo': 'CM-1', 'mfgDate': '2026-11-15', 'expiryDate': '2027-11-15', 'qty': 60} and len(dp) == 1
    pg.screenshot(path='%s/vendor-1-manufacturing.png' % OUT, full_page=True)
    prof_ok = pg.is_visible('text=Your products and prices') and pg.is_visible('text=These are verified by us') and pg.is_visible('button:has-text("Save business profile")')
    pg.click('button:has-text("Submit a price")'); pg.wait_for_timeout(300)
    pg.get_by_label('Unit price ex-GST (₹)').fill('62.50'); pg.click('button:has-text("Send for approval")'); pg.wait_for_timeout(600)
    pp = [p for p in vposts if p[0] == '/api/vendor/price-lists']
    price_ok = len(pp) == 1 and pp[0][1]['vendorProductId'] == 11 and pp[0][1]['unitPrice'] == 62.5 and pp[0][1]['gstRate'] == 5
    pg.get_by_label('Trade name').fill('Mandya Cane'); pg.click('button:has-text("Save business profile")'); pg.wait_for_timeout(500)
    pf = [p for p in vposts if p[0] == '/api/vendor/profile']
    profile_ok = len(pf) == 1 and pf[0][1]['tradeName'] == 'Mandya Cane' and 'gstin' not in pf[0][1] and 'legalName' not in pf[0][1]
    results.append(ws_ok and accept_ok and batch_ok and prof_ok and price_ok and profile_ok and not errs)
    print('PASS' if results[-1] else 'FAIL', 'manufacturer workspace | sections', ws_ok, '| accept once', accept_ok, '| batch + certificate', batch_ok, '| profile + products', prof_ok, '| price submission', price_ok, '| profile save (no identity fields)', profile_ok, '| errors', errs)
    ctx.close()

    # ── retailer portal: the shipment card and the challan ──
    ctx = b.new_context(viewport={'width': 390, 'height': 844}); pg = ctx.new_page(); errs = []; got = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    order = {'order': {'id': 30, 'order_no': 'SO2611-0001', 'status': 'out_for_delivery', 'seller_type': 'company', 'igst_total': '0', 'cgst_total': '25.00', 'sgst_total': '25.00', 'taxable_total': '1000.00', 'round_off': '0', 'grand_total': '1050.00', 'total_qty': 10,
             'payment_status': 'paid', 'payment_method': 'upi', 'amount_paid': '1050.00', 'ship_name': 'Ganesh Stores', 'ship_line1': 'MG Road', 'ship_city': 'Bengaluru', 'ship_state': 'Karnataka', 'ship_pincode': '560001', 'ship_phone': '9845011111', 'is_on_hold': 0},
             'items': [{'id': 1, 'name': T + 'Jaggery 1 kg', 'sku': 'JAG1', 'qty': 10, 'unit_price': '100.00', 'gst_rate': '5.00', 'line_total': '1050.00', 'qty_delivered': None, 'qty_returned': 0}],
             'history': [{'to_status': 'out_for_delivery', 'created_at': '2026-11-18T10:00:00Z', 'note': None}], 'invoice': None, 'payments': [], 'returns': [], 'nextStatuses': [], 'outstanding': '0.00',
             'shipment': {'id': 70, 'shipmentNo': 'SHP/2627/00001', 'status': 'out_for_delivery', 'mode': 'own_vehicle', 'vehicleNo': 'KA01AB1234', 'driverName': 'Ravi', 'driverPhone': '9845000004', 'trackingNo': None, 'lrNo': None,
                          'ewayBillNo': None, 'challanNo': 'DC/2627/00001', 'expectedAt': '2026-11-19T10:00:00Z', 'late': False, 'attempts': 0, 'receivedBy': None,
                          'events': [{'kind': 'dispatched', 'note': None, 'place': None, 'at': '2026-11-18T09:00:00Z'}, {'kind': 'out_for_delivery', 'note': None, 'place': 'Bengaluru', 'at': '2026-11-18T10:00:00Z'}]}}
    def b2bapi(route):
        r = route.request; u = r.url.replace(base, ''); got.append(u)
        if u == '/api/b2b/me': return route.fulfill(json={'account': {'id': 5, 'account_type': 'retailer', 'status': 'approved', 'business_name': 'Ganesh Stores', 'shop_name': 'Ganesh Stores', 'contact_person': 'Owner', 'email': 'g@r.test', 'mobile': '9845011111'}, 'user': {'name': 'Owner'}})
        if u.startswith('/api/b2b/orders/30/challan'): return route.fulfill(body='<!doctype html><title>Delivery challan DC/2627/00001</title><h1>Delivery challan</h1>', content_type='text/html')
        if u.startswith('/api/b2b/orders/30'): return route.fulfill(json=order)
        if u.startswith('/api/b2b/cart'): return route.fulfill(json={'items': []})
        return route.fulfill(json={'items': [], 'total': 0})
    pg.route('**/api/b2b/**', b2bapi)
    pg.goto(base + '/b2b/login', wait_until='domcontentloaded'); pg.evaluate("() => localStorage.setItem('soh_b2b', JSON.stringify({ token: 'fixture-token' }))")
    pg.goto(base + '/b2b/orders/30', wait_until='networkidle'); pg.wait_for_timeout(700)
    card_ok = pg.is_visible('text=Shipment') and pg.is_visible('text=KA01AB1234') and pg.is_visible('text=DC/2627/00001')
    with pg.expect_popup() as pop: pg.click('#challanBtn')
    ch = pop.value; ch.wait_for_load_state(); challan_ok = any(x.startswith('/api/b2b/orders/30/challan') for x in got); ch.close()
    pg.screenshot(path='%s/portal-1-shipment.png' % OUT, full_page=True)
    results.append(card_ok and challan_ok and not errs)
    print('PASS' if results[-1] else 'FAIL', 'retailer portal | shipment card', card_ok, '| challan with token', challan_ok, '| errors', errs)
    ctx.close()

    # ── field app: my deliveries, an update made offline is kept and sent once ──
    ctx = b.new_context(viewport={'width': 390, 'height': 844}); pg = ctx.new_page(); errs = []; synced = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    mine = dict(ship, status='dispatched', orderStatus='dispatched')
    def field(route):
        r = route.request; u = r.url.replace(base, '')
        if u.startswith('/api/sales/me'): return route.fulfill(status=403, json={'error': 'not a salesman', 'code': 'not_salesman'})
        if u.startswith('/api/erp/events'): return route.fulfill(status=403, json={'error': 'no'})
        if u.startswith('/api/erp/offline/sync'):
            body = json.loads(r.post_data or '{}'); synced.append(body)
            return route.fulfill(json={'results': [{'clientOpId': o['clientOpId'], 'status': 'applied', 'result': {'id': 70}} for o in body['ops']]})
        if u.startswith('/api/erp/deliveries'): return route.fulfill(json={'items': [mine]})
        return route.fulfill(json={})
    pg.route('**/api/sales/**', field); pg.route('**/api/erp/**', field)
    pg.goto(base + '/sales-app/', wait_until='networkidle'); pg.evaluate("t => sessionStorage.setItem('sales.token', t)", erp_tok)
    pg.goto(base + '/sales-app/', wait_until='networkidle'); pg.wait_for_timeout(700)
    list_ok = pg.is_visible('text=My deliveries') and pg.is_visible('text=Call Owner')
    ctx.set_offline(True)
    pg.click('button:has-text("Out for delivery")'); pg.wait_for_timeout(1500)
    stored = pg.evaluate("""() => new Promise(r => { const q = indexedDB.open('soh-field'); q.onsuccess = () => { const t = q.result.transaction('ops').objectStore('ops').getAll(); t.onsuccess = () => r(t.result); }; })""")
    saved = pg.is_visible('text=No connection: saved on this phone')
    pg.screenshot(path='%s/field-1-delivery-offline.png' % OUT, full_page=True)
    ctx.set_offline(False); pg.evaluate("window.dispatchEvent(new Event('online'))"); pg.wait_for_timeout(2500)
    op = stored[0] if stored else {}
    field_ok = list_ok and saved and len(stored) == 1 and op.get('kind') == 'delivery' and op.get('payload', {}).get('action') == 'out_for_delivery' and op.get('payload', {}).get('shipmentId') == 70 \
        and len(synced) == 1 and synced[0]['ops'][0]['clientOpId'] == op.get('clientOpId') == op.get('payload', {}).get('clientUuid') and not errs
    results.append(field_ok)
    print('PASS' if field_ok else 'FAIL', 'field app deliveries | list', list_ok, '| saved offline', saved, '| stored', len(stored), '| sent once with same id', len(synced) == 1, '| errors', errs)
    b.close()
finally:
    srv.terminate()
print('RESULT', 'PASS' if results and all(results) else 'FAIL')
