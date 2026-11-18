/**
 * SohAuth — lightweight client for optional customer accounts.
 * Token is kept in localStorage under 'soh_customer'. Nothing here is
 * required for checkout; it only powers the optional login/account page
 * and the nav's logged-in state.
 */
(function (window) {
  const STORAGE_KEY = 'soh_customer';

  function save(token, user) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: token, user: user }));
  }

  function clear() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function read() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  async function request(path, options) {
    const stored = read();
    const headers = Object.assign({ 'Content-Type': 'application/json' }, (options && options.headers) || {});
    if (stored && stored.token) headers['Authorization'] = 'Bearer ' + stored.token;
    const res = await fetch(path, Object.assign({}, options, { headers: headers }));
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  async function login(email, password) {
    const data = await request('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ email: email, password: password }),
    });
    save(data.token, data.user);
    return data.user;
  }

  async function signup(email, password, name) {
    const data = await request('/api/auth/signup', {
      method: 'POST', body: JSON.stringify({ email: email, password: password, name: name }),
    });
    save(data.token, data.user);
    return data.user;
  }

  function logout() { clear(); }

  function currentUser() {
    const stored = read();
    return stored ? stored.user : null;
  }

  async function myOrders() {
    const data = await request('/api/auth/orders');
    return data.orders || [];
  }

  window.SohAuth = { login, signup, logout, currentUser, myOrders };
})(window);
