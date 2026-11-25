/**
 * Test helper — boots the real server as a child process on a free port with
 * an isolated, throw-away JSON data directory, so tests can never touch real
 * B2C data.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..', '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startServer(extraEnv) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-test-data-'));
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-test-private-'));
  const env = Object.assign({}, process.env, {
    PORT: String(port),
    NODE_ENV: 'test',
    DATA_DIR: dataDir,
    CATALOGUE_DIR: path.join(dataDir, '.catalogue-test'),
    BACKUP_DIR: path.join(dataDir, '.backups-test'),
    B2B_PRIVATE_DIR: privateDir,
    PAYMENT_MOCK: 'true',
    AUTO_SEED: 'true',
    ADMIN_EMAIL: 'admin@test.local',
    ADMIN_PASSWORD: 'Test@12345',
    ADMIN_JWT_SECRET: 'test-admin-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
    CUSTOMER_JWT_SECRET: 'test-customer-secret-0123456789-abcdefghijklmnopqrstuv',
    SMTP_HOST: '', SMTP_USER: '', WHATSAPP_TOKEN: '', TWILIO_ACCOUNT_SID: '',
    RAZORPAY_KEY_ID: '',
  }, extraEnv || {});

  const child = spawn(process.execPath, ['index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });

  const base = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const r = await fetch(base + '/health');
      if (r.ok) break;
    } catch (e) { /* not up yet */ }
    if (child.exitCode != null) throw new Error('Server exited early:\n' + log);
    if (Date.now() > deadline) { child.kill(); throw new Error('Server did not start:\n' + log); }
    await new Promise(r => setTimeout(r, 120));
  }

  async function call(method, url, body, headers) {
    const opts = { method, headers: Object.assign({}, headers || {}) };
    if (body !== undefined && !(body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    } else if (body instanceof FormData) {
      opts.body = body;
    }
    const res = await fetch(base + url, opts);
    // On GitHub (CI), a server error prints the server's last log lines as TAP comments, so the cause is visible.
    if (res.status >= 500 && process.env.CI) {
      await new Promise(function (r) { setTimeout(r, 300); });   // the server's error line arrives on its own pipe
      const lines = log.split('\n').filter(function (l) { return /ERROR|Error|error|^\s+at /.test(l); }).slice(-20);
      process.stdout.write(lines.map(function (l) { return '# server: ' + l; }).join('\n') + '\n');
    }
    const ct = res.headers.get('content-type') || '';
    let data = null;
    if (ct.includes('application/json')) data = await res.json();
    else data = await res.text();
    return { status: res.status, data, headers: res.headers };
  }

  return {
    base, port, dataDir, privateDir, child,
    log: () => log,
    get: (u, h) => call('GET', u, undefined, h),
    post: (u, b, h) => call('POST', u, b === undefined ? {} : b, h),
    patch: (u, b, h) => call('PATCH', u, b, h),
    put: (u, b, h) => call('PUT', u, b, h),
    del: (u, h) => call('DELETE', u, undefined, h),
    stop: () => new Promise(resolve => {
      if (child.exitCode != null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 3000);
    }),
  };
}

const bearer = token => ({ Authorization: 'Bearer ' + token });

/**
 * A complete, valid production configuration for tests (src/config/env.js refuses to start production
 * without one). Test values only: fake Razorpay TEST keys, throw-away folders, long test secrets.
 */
const PROD_ADMIN_PASSWORD = 'Test@12345-production';
function prodEnv(extra) {
  return Object.assign({
    NODE_ENV: 'production',
    SITE_URL: 'https://shop.example.test',
    ADMIN_PASSWORD: PROD_ADMIN_PASSWORD,
    RAZORPAY_KEY_ID: 'rzp_test_FakeKeyForTests1',
    RAZORPAY_KEY_SECRET: 'fake-razorpay-test-secret',
    JOBS_MODE: 'cron',
    PAYMENT_MOCK: 'false',
  }, extra || {});
}

module.exports = { startServer, bearer, ROOT, prodEnv, PROD_ADMIN_PASSWORD };
