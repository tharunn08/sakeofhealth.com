"""ERP screens inside the central Admin Panel — browser check.
Part A (real server, business database unreachable): what staff actually see.
Part B (LAYOUT CHECK ONLY): the sidebar is the one the real registry builds for a
person holding every ERP permission (erp-fixture.json); every /api/erp call
answers an EMPTY list. No business records are invented. Proves the 18 screens
draw inside the shell (desktop + mobile, no script errors, links stay in the
shell); does NOT prove anything about real data (needs MySQL 8)."""
import json, os, subprocess, sys, tempfile, time, urllib.request, base64, hmac, hashlib
from playwright.sync_api import sync_playwright
ROOT = os.environ.get('SOH_ROOT', '/home/claude/dev/soh'); OUT = '/home/claude/dev/checks/erp'; os.makedirs(OUT, exist_ok=True)
FIX = json.load(open('/home/claude/dev/checks/erp-fixture.json'))
ERP_SECRET = 'unit-test-erp-secret-0123456789abcdef'
env = dict(os.environ, PORT='5193', NODE_ENV='test', DATA_DIR=tempfile.mkdtemp(), B2B_PRIVATE_DIR=tempfile.mkdtemp(), PAYMENT_MOCK='true', AUTO_SEED='true',
  ADMIN_EMAIL='admin@test.local', ADMIN_PASSWORD='Test@12345', B2B_ENABLED='true', ERP_ENABLED='true', B2B_JWT_SECRET='test-b2b-secret-not-for-production-123',
  ERP_JWT_SECRET=ERP_SECRET, DB_HOST='127.0.0.1', DB_PORT='1', DB_USER='nobody', DB_PASSWORD='x', DB_NAME='nothing',
  ADMIN_JWT_SECRET='test-admin-secret-0123456789-abcdefghijklmnopqrstuvwxyz', CUSTOMER_JWT_SECRET='test-customer-secret-0123456789-abcdefghijklmnopqrstuv', RAZORPAY_KEY_ID='', SMTP_HOST='')
srv = subprocess.Popen(['node', 'index.js'], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
base = 'http://127.0.0.1:5193'
for _ in range(100):
    try: urllib.request.urlopen(base + '/health'); break
    except Exception: time.sleep(0.15)
# an ERP token the server can verify (its staff row cannot be read: database down)
erp_tok = subprocess.run(['node', '-e', "process.env.ERP_JWT_SECRET='%s';process.stdout.write(require('./src/modules/erp/core/security.js').sign({sid:1,tv:0,mfa:false,ses:'check'}))" % ERP_SECRET], cwd=ROOT, capture_output=True, text=True, env=dict(os.environ, DATA_DIR=tempfile.mkdtemp())).stdout
ok = True
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    # ── Part A: real server, database down ──
    ctx = b.new_context(viewport={'width': 1366, 'height': 900}); pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)[:150]))
    pg.goto(base + '/login'); pg.fill('#email', 'admin@test.local'); pg.fill('#password', 'Test@12345'); pg.click('#submitBtn')
    pg.wait_for_url('**/admin/*/*'); pg.evaluate("t => localStorage.setItem('soh_erp_token', t)", erp_tok); pg.evaluate("sessionStorage.clear()")
    pg.goto(base + '/admin/overview/dashboard'); pg.wait_for_timeout(1200)
    notice = pg.inner_text('#sbNav .sb-group-title') if pg.query_selector('#sbNav') else ''
    erp_links = pg.eval_on_selector_all('#sbNav a', 'els => els.filter(e => e.getAttribute("href").match(/system|vendors|batches/)).length')
    pg.screenshot(path=OUT + '/A-db-down-sidebar.png')
    pg.goto(base + '/admin/procurement/vendors'); pg.wait_for_timeout(1200)
    redirected = pg.url.replace(base, '')
    print('A (real, DB down): sidebar notice = %r | ERP links shown = %d | opening an ERP screen goes to %s | page errors %s' % (notice, erp_links, redirected, errs))
    ok &= 'unavailable' in notice.lower() and erp_links == 0 and redirected == '/admin/overview/dashboard' and not errs
    ctx.close()
    # ── Part B: layout check, empty responses ──
    me = {'id': 1, 'name': 'Layout Check', 'email': 'layout@check.local', 'roles': ['super_admin'], 'permissions': FIX['perms'], 'scopes': {'territory': 'all', 'warehouse': 'all', 'state': 'all'}, 'mfa': True}
    erp_pages = [i for g in FIX['nav']['groups'] for i in g['items'] if i['module'] == 'erp']
    results = []
    for view, vp in [('desktop', {'width': 1366, 'height': 900}), ('mobile', {'width': 390, 'height': 844})]:
        ctx = b.new_context(viewport=vp); pg = ctx.new_page(); errs = []; calls = []
        pg.on('pageerror', lambda e: errs.append(str(e)[:150]))
        def erp_api(route):
            u = route.request.url.replace(base, ''); calls.append(route.request.method + ' ' + u)
            if u.startswith('/api/erp/core/me'): return route.fulfill(json=me)
            if u.startswith('/api/erp/core/monitoring'): return route.fulfill(json={'database': 'empty (layout check)', 'openCritical': 0, 'notificationQueue': {}, 'jobs': {}, 'lastBackup': {'status': 'none'}, 'inventoryReconciliation': 'none', 'events24h': [], 'migrations': []})
            return route.fulfill(json={'items': []})
        pg.route('**/api/erp/**', erp_api)
        pg.route('**/api/platform/nav', lambda route: route.fulfill(json=FIX['nav']))
        pg.goto(base + '/login'); pg.fill('#email', 'admin@test.local'); pg.fill('#password', 'Test@12345'); pg.click('#submitBtn'); pg.wait_for_url('**/admin/*/*')
        pg.evaluate("t => localStorage.setItem('soh_erp_token', t)", erp_tok)
        for it in erp_pages:
            errs.clear()
            pg.goto(base + it['path'], wait_until='networkidle'); pg.wait_for_timeout(250)
            h1 = pg.inner_text('#content h1') if pg.query_selector('#content h1') else ''
            in_shell = bool(pg.query_selector('#sidebar')) and bool(pg.query_selector('#content.erp-embed'))
            active = pg.eval_on_selector('#sbNav a.active', 'e => e && e.getAttribute("href")') if pg.query_selector('#sbNav a.active') else None
            own_ui = bool(pg.query_selector('nav.side')) or bool(pg.query_selector('form.login'))
            r = {'view': view, 'path': it['path'], 'h1': h1, 'in_shell': in_shell, 'active_ok': active == it['path'], 'no_own_menu_or_login': not own_ui, 'errors': list(errs), 'url_ok': pg.url.replace(base, '') == it['path']}
            results.append(r)
            if view == 'mobile' and it['view'] in ('vendors', 'purchasing', 'staff', 'stock'): pg.screenshot(path='%s/B-mobile-%s.png' % (OUT, it['view']), full_page=True)
            if view == 'desktop' and it['view'] in ('vendors', 'overview', 'approvals', 'pricing', 'stock', 'account'): pg.screenshot(path='%s/B-desktop-%s.png' % (OUT, it['view']))
        bad = [r for r in results if r['view'] == view and not (r['h1'] and r['in_shell'] and r['active_ok'] and r['no_own_menu_or_login'] and not r['errors'] and r['url_ok'])]
        print('B (layout, %s): %d ERP screens, %d with problems, %d ERP calls answered' % (view, len(erp_pages), len(bad), len(calls)))
        for x in bad: print('   ', json.dumps(x)[:300])
        ok &= not bad
        ctx.close()
    json.dump(results, open(OUT + '/results.json', 'w'), indent=1)
    b.close()
finally:
    srv.terminate()
print('RESULT', 'PASS' if ok else 'FAIL'); sys.exit(0 if ok else 1)
