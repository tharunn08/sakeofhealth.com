"""Central Admin Panel browser check (test data only): sign in at /login as each
role, walk every sidebar link, desktop + mobile. Trade (B2B) pages run with the
business platform on and NO database, so their APIs answer 503 by design."""
import json, os, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright
ROOT = os.environ.get('SOH_ROOT', '/home/claude/dev/soh'); OUT = '/home/claude/dev/checks/shell'; os.makedirs(OUT, exist_ok=True)
env = dict(os.environ, PORT='5192', NODE_ENV='test', DATA_DIR=tempfile.mkdtemp(), B2B_PRIVATE_DIR=tempfile.mkdtemp(), PAYMENT_MOCK='true', AUTO_SEED='true',
  ADMIN_EMAIL='admin@test.local', ADMIN_PASSWORD='Test@12345', B2B_ENABLED='true', B2B_JWT_SECRET='test-b2b-secret-not-for-production-123',
  DB_HOST='127.0.0.1', DB_PORT='1', DB_USER='nobody', DB_PASSWORD='x', DB_NAME='nothing',
  ADMIN_JWT_SECRET='test-admin-secret-0123456789-abcdefghijklmnopqrstuvwxyz', CUSTOMER_JWT_SECRET='test-customer-secret-0123456789-abcdefghijklmnopqrstuv', RAZORPAY_KEY_ID='', SMTP_HOST='')
srv = subprocess.Popen(['node', 'index.js'], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
base = 'http://127.0.0.1:5192'
def post(url, body, token=None):
    req = urllib.request.Request(base + url, method='POST', data=json.dumps(body).encode(), headers=dict({'Content-Type': 'application/json'}, **({'Authorization': 'Bearer ' + token} if token else {})))
    with urllib.request.urlopen(req) as r: return json.load(r)
for _ in range(100):
    try: urllib.request.urlopen(base + '/health'); break
    except Exception: time.sleep(0.15)
adm = post('/api/admin/login', {'email': 'admin@test.local', 'password': 'Test@12345'})['token']
for role in ['manager', 'staff', 'delivery', 'sales']:
    post('/api/admin/staff', {'name': 'UI ' + role, 'email': role + '@ui.test', 'phone': '9000000020', 'role': role, 'password': 'ui-pass-1234'}, adm)
post('/api/admin/staff', {'name': 'Both', 'email': 'both@ui.test', 'phone': '9000000021', 'role': 'staff', 'password': 'both-pass-123'}, adm)
post('/api/auth/signup', {'name': 'Both', 'email': 'both@ui.test', 'phone': '9000000022', 'password': 'both-pass-123'})
p = next(x for x in json.load(urllib.request.urlopen(base + '/api/shop/products'))['products'] if not x['upcoming'])
post('/api/shop/orders', {'items': [{'id': p['id'], 'qty': 1}], 'customer': {'name': 'Shell', 'email': 'shell@t.l', 'phone': '9876500099'}, 'address': {'line1': 'MG Road', 'city': 'Bengaluru', 'state': 'Karnataka', 'pincode': '560001'}})
ok = True; report = []
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    for view, vp in [('desktop', {'width': 1366, 'height': 900}), ('mobile', {'width': 390, 'height': 844})]:
      for email, pw_ in [('admin@test.local', 'Test@12345'), ('manager@ui.test', 'ui-pass-1234'), ('staff@ui.test', 'ui-pass-1234'), ('delivery@ui.test', 'ui-pass-1234'), ('sales@ui.test', 'ui-pass-1234')]:
        ctx = b.new_context(viewport=vp); pg = ctx.new_page(); errs = []; bad = []
        pg.on('pageerror', lambda e: errs.append(str(e)[:150]))
        pg.on('response', lambda r: bad.append('%d %s' % (r.status, r.url.replace(base, ''))) if r.url.startswith(base) and r.status >= 400 else None)
        pg.goto(base + '/login'); pg.fill('#email', email); pg.fill('#password', pw_); pg.click('#submitBtn')
        pg.wait_for_url('**/admin/*/*', timeout=10000); pg.wait_for_timeout(900)
        landed = pg.url.replace(base, '')
        if view == 'mobile': pg.click('#hamburger'); pg.wait_for_timeout(300)
        links = pg.eval_on_selector_all('#sbNav a.sb-link', 'els => els.map(e => [e.getAttribute("href"), e.textContent.trim()])')
        groups = pg.eval_on_selector_all('#sbNav .sb-group-title', 'els => els.map(e => e.textContent.trim())')
        pg.screenshot(path='%s/%s-%s-menu.png' % (OUT, view, email.split('@')[0]))
        visited = []
        for href, label in links:
            errs.clear()
            pg.goto(base + href, wait_until='networkidle'); pg.wait_for_timeout(300)
            active = pg.eval_on_selector('#sbNav a.active', 'e => e && e.getAttribute("href")') if pg.query_selector('#sbNav a.active') else None
            title = pg.inner_text('.topbar h1') if pg.query_selector('.topbar h1') else ''
            visited.append({'href': href, 'url': pg.url.replace(base, ''), 'active_ok': active == href, 'title': title, 'errors': list(errs)})
        unexpected = [x for x in bad if not (x.startswith('503 /api/admin/b2b') or x.startswith('503 /api/b2b'))]
        r = {'view': view, 'user': email, 'landed': landed, 'groups': groups, 'links': len(links), 'unexpected_failed_requests': sorted(set(unexpected)),
             'b2b_503_by_design': len([x for x in bad if x.startswith('503')]),
             'pages_with_errors': [v for v in visited if v['errors']], 'not_active_or_redirected': [v['href'] for v in visited if not v['active_ok'] or v['url'] != v['href']]}
        report.append(r)
        good = not r['unexpected_failed_requests'] and not r['pages_with_errors'] and not r['not_active_or_redirected'] and len(links) > 0
        ok &= good
        print(('OK  ' if good else 'BAD '), view, email, '→', landed, '|', len(links), 'links in', groups, '| trade 503s:', r['b2b_503_by_design'])
        if not good: print('    ', json.dumps({k: r[k] for k in ['unexpected_failed_requests', 'pages_with_errors', 'not_active_or_redirected']})[:600])
        ctx.close()
    # someone who is both staff and a shop customer gets a choice
    ctx = b.new_context(); pg = ctx.new_page(); pg.goto(base + '/login'); pg.fill('#email', 'both@ui.test'); pg.fill('#password', 'both-pass-123'); pg.click('#submitBtn')
    pg.wait_for_selector('#chooser:not([hidden])'); choices = pg.eval_on_selector_all('#chooserList button', 'els => els.map(e => e.textContent)')
    pg.screenshot(path=OUT + '/chooser.png'); pg.click('text=My account (shop)'); pg.wait_for_url('**/account.html'); pg.wait_for_timeout(600)
    shop_ok = pg.evaluate("!!JSON.parse(localStorage.getItem('soh_customer')||'null')") and not pg.evaluate("localStorage.getItem('soh_admin_token')")
    print('chooser:', choices, '| chose shop → account page, only the shop session stored:', shop_ok); ok &= len(choices) == 2 and shop_ok
    # wrong password
    pg.goto(base + '/login'); pg.fill('#email', 'admin@test.local'); pg.fill('#password', 'nope-nope'); pg.click('#submitBtn'); pg.wait_for_selector('.alert-error')
    print('wrong password message:', pg.inner_text('.alert-error')); ok &= 'Incorrect' in pg.inner_text('.alert-error')
    b.close()
finally:
    srv.terminate()
json.dump(report, open(OUT + '/results.json', 'w'), indent=1)
print('RESULT', 'PASS' if ok else 'FAIL'); sys.exit(0 if ok else 1)
