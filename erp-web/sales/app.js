/* Field sales and event counter app (phone-first). Staff sign in with their staff account.
   Salesmen: retailers in their territory, orders that wait for the retailer's one-time code,
   check-ins. Event staff: the counter of the events they are assigned to (GST invoices).
   Everyone: "share my location" (GPS or typed in). Without a connection, sales, check-ins,
   orders and locations wait in the offline queue (queue.js) and are sent when it returns; the
   server does each one once. Text via textContent only; the server checks everything again. */
(function () {
  'use strict';
  var token = null; try { token = sessionStorage.getItem('sales.token'); } catch (e) { /* */ }
  var root = document.getElementById('app');
  var Q = window.SOH_QUEUE;
  var cart = {};   // productId → qty (in memory only)
  var who = { salesman: null, events: [] };
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'on') Object.keys(attrs.on).forEach(function (ev) { n.addEventListener(ev, attrs.on[ev]); });
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function api(method, url, body) {
    var h = { 'Content-Type': 'application/json' }; if (token) h.Authorization = 'Bearer ' + token;
    return fetch(url, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 && !/login$/.test(url)) logout();
        if (!r.ok) { var e = new Error(j.error || 'Request failed'); e.code = j.code; e.data = j; e.status = r.status; throw e; }
        return j;
      });
    });
  }
  function msg(k, t) { return el('div', { class: 'msg ' + k, role: k === 'err' ? 'alert' : 'status', text: t }); }
  function btn(t, f, k) { return el('button', { class: 'btn' + (k ? ' ' + k : ''), type: 'button', text: t, on: { click: f } }); }
  function uuid() { return Q.uuid(); }
  function money(v) { return '₹' + Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function logout() { token = null; try { sessionStorage.removeItem('sales.token'); } catch (e) { /* */ } start(); }
  function offline(e) { return Q.isNetworkError(e) || navigator.onLine === false; }
  /** Online first; without a connection the operation waits in the queue under the same id. */
  function sendOrQueue(kind, url, payload, label, opId, onDone, out) {
    if (navigator.onLine === false) return Q.add(kind, payload, label, opId).then(function () { out.replaceChildren(msg('warn', 'No connection: saved on this phone, will be sent automatically.')); });
    return api('POST', url, payload).then(onDone).catch(function (e) {
      if (!offline(e)) { out.replaceChildren(msg('err', e.message)); return; }
      return Q.add(kind, payload, label, opId).then(function () { out.replaceChildren(msg('warn', 'No connection: saved on this phone, will be sent automatically.')); });
    });
  }

  function login(error) {
    var e = el('input', { type: 'email', autocomplete: 'username' }), p = el('input', { type: 'password', autocomplete: 'current-password' }), c = el('input', { inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: 'only if asked' });
    return el('div', { class: 'panel login' }, [el('h1', { text: 'Field & event app' }), error ? msg('err', error) : null, el('label', {}, ['E-mail', e]), el('label', {}, ['Password', p]), el('label', {}, ['Authenticator code', c]),
      btn('Sign in', function () {
        api('POST', '/api/erp/core/login', { email: e.value, password: p.value, totp: c.value || undefined }).then(function (r) { token = r.token; try { sessionStorage.setItem('sales.token', r.token); } catch (x) { /* */ } start(); })
          .catch(function (x) { root.replaceChildren(login(x.message)); });
      }, 'primary')]);
  }

  // ── The queue panel: what waits, what went through, what needs the office ──
  function queuePanel() {
    var box = el('div', { class: 'panel queue', 'aria-live': 'polite' });
    function draw(ops) {
      var pending = ops.filter(function (o) { return o.status === 'pending'; }), stuck = ops.filter(function (o) { return o.status !== 'pending'; });
      var kids = [el('div', { class: 'row' }, [el('strong', { text: pending.length ? pending.length + ' waiting to send' : 'Nothing waiting' }), navigator.onLine === false ? el('span', { class: 'tag pending', text: 'offline' }) : null,
        btn('Send now', function () { Q.sync(); })])];
      stuck.forEach(function (o) {
        kids.push(el('div', { class: 'msg ' + (o.status === 'conflict' ? 'warn' : 'err') }, [o.label + ': ' + (o.error || o.status) + ' — the office can see this and settle it. ',
          btn('Hide on this phone', function () { if (window.confirm('Hide this from the phone? It stays recorded in the office.')) Q.remove(o.clientOpId); })]));
      });
      Q.recent().slice(0, 3).forEach(function (d) { kids.push(el('div', { class: 'note', text: 'Sent: ' + d.label + (d.result && d.result.invoiceNo ? ' → ' + d.result.invoiceNo : '') + (d.result && d.result.orderNo ? ' → order ' + d.result.orderNo + ' (ask the retailer for the code)' : '') })); });
      box.replaceChildren.apply(box, kids);
    }
    Q.onChange(draw);
    return box;
  }

  function locationButton(subject, eventId, out) {
    return btn('Share my location', function () {
      var send = function (pos, manual) {
        var p = { clientUuid: uuid(), subject: subject, eventId: eventId || undefined, purpose: subject === 'event' ? 'stall' : 'check_in', capturedAt: new Date().toISOString() };
        if (manual) { p.lat = manual.lat; p.lng = manual.lng; p.source = 'manual'; p.note = manual.note; }
        else { p.lat = pos.coords.latitude; p.lng = pos.coords.longitude; p.accuracy = pos.coords.accuracy; p.source = 'gps'; }
        sendOrQueue('location', '/api/erp/locations', p, 'Location', p.clientUuid, function () { out.replaceChildren(msg('ok', 'Location recorded.')); }, out);
      };
      var typed = function () {
        var v = window.prompt('GPS is not available. Type the position as "latitude, longitude" (from a maps app):'); if (!v) return;
        var m = v.split(',').map(function (x) { return Number(x.trim()); });
        if (m.length !== 2 || !isFinite(m[0]) || !isFinite(m[1])) { out.replaceChildren(msg('err', 'That is not a latitude, longitude pair.')); return; }
        send(null, { lat: m[0], lng: m[1], note: 'typed in' });
      };
      if (navigator.geolocation) navigator.geolocation.getCurrentPosition(function (pos) { send(pos); }, typed, { timeout: 10000, enableHighAccuracy: true }); else typed();
    });
  }

  function home() {
    var main = el('main', { id: 'main' }), out = el('div');
    main.appendChild(el('div', { class: 'row' }, [el('h1', { text: who.salesman ? who.salesman.salesman.name : 'Event counter' }), btn('Sign out', logout)]));
    main.appendChild(queuePanel());
    Q.persistent().then(function (ok) { if (!ok) main.insertBefore(msg('warn', 'This browser cannot keep unsent work after the page closes: stay on this page until it is sent.'), main.children[1]); });
    main.appendChild(out);
    if (who.events.length) {
      main.appendChild(el('h2', { text: 'My events' }));
      who.events.forEach(function (ev) {
        main.appendChild(el('div', { class: 'panel' }, [el('strong', { text: ev.code + ' — ' + ev.name }), el('div', { class: 'note', text: ev.startsOn + ' → ' + ev.endsOn + ' · ' + ev.status }),
          ev.status === 'open' ? btn('Open counter', function () { counter(ev); }, 'primary') : el('span', { class: 'tag pending', text: ev.status === 'planned' ? 'not open yet' : 'closed' }),
          locationButton('event', ev.id, out)]));
      });
    }
    if (who.salesman) salesHome(main, who.salesman, out);
    root.replaceChildren(el('div', { class: 'shell' }, [main]));
  }

  function salesHome(main, me, out) {
    if (!/enabled/.test(me.otpOrdering)) main.appendChild(msg('warn', 'Ordering: ' + me.otpOrdering));
    main.appendChild(el('p', { class: 'note', text: 'Cash in hand: ₹' + me.cashInHand + ' (limit ₹' + me.salesman.cashLimit + ')' }));
    main.appendChild(locationButton('salesman', null, out));
    var q = el('input', { 'aria-label': 'Search retailers', placeholder: 'Shop, mobile or pincode' }), list = el('div');
    main.appendChild(el('h2', { text: 'Retailers' }));
    main.appendChild(el('div', { class: 'row' }, [q, btn('Search', function () { load(q.value); })]));
    main.appendChild(list);
    function load(term) {
      api('GET', '/api/sales/retailers?q=' + encodeURIComponent(term || '')).then(function (r) {
        try { localStorage.setItem('soh.retailers', JSON.stringify(r.items.slice(0, 200).map(function (a) { return { id: a.id, shop_name: a.shop_name, business_name: a.business_name, city: a.city, pincode: a.pincode, status: a.status }; }))); } catch (e) { /* only a convenience list */ }
        draw(r.items);
      }).catch(function (x) {
        if (!offline(x)) { list.replaceChildren(msg('err', x.message)); return; }
        var cached = []; try { cached = JSON.parse(localStorage.getItem('soh.retailers') || '[]'); } catch (e) { /* */ }
        list.replaceChildren(msg('warn', 'Offline: showing the retailers last loaded on this phone.'));
        draw(cached, true);
      });
    }
    function draw(items, cached) {
      if (!cached) list.replaceChildren();
      items.forEach(function (a) {
        var o = el('div');
        list.appendChild(el('div', { class: 'panel' }, [el('strong', { text: a.shop_name || a.business_name }), el('div', { class: 'note', text: (a.city || '') + ' ' + (a.pincode || '') + ' · ' + a.status }),
          a.status === 'approved' ? btn('Take order', function () { order(a); }, 'primary') : el('span', { class: 'tag pending', text: 'awaiting approval' }),
          btn('Check in', function () {
            var send = function (pos) {
              var p = { retailerId: a.id, clientUuid: uuid(), latitude: pos && pos.coords.latitude, longitude: pos && pos.coords.longitude };
              sendOrQueue('visit', '/api/sales/visits', p, 'Check-in at ' + (a.shop_name || a.business_name), p.clientUuid,
                function (v) { o.replaceChildren(msg(v.flagged ? 'warn' : 'ok', 'Checked in' + (v.flagged ? ' — ' + v.flagged : ''))); }, o);
            };
            if (navigator.geolocation) navigator.geolocation.getCurrentPosition(send, function () { send(null); }, { timeout: 8000 }); else send(null);
          }), o]));
      });
    }
    load('');
  }

  function order(a) {
    cart = {};
    var main = el('main', { id: 'main' }, [el('h1', { text: 'Order for ' + (a.shop_name || a.business_name) }), btn('← Back', start)]);
    var out = el('div'), items = el('div');
    main.appendChild(out); main.appendChild(items);
    api('GET', '/api/sales/catalogue?retailerId=' + a.id + '&limit=200').then(function (c) {
      items.replaceChildren.apply(items, c.items.filter(function (p) { return !p.problem; }).map(function (p) {
        var qty = el('input', { inputmode: 'numeric', 'aria-label': 'Quantity of ' + p.name, placeholder: '0', style: 'width:90px' });
        qty.addEventListener('input', function () { var n = parseInt(qty.value, 10); if (n > 0) cart[p.productId] = n; else delete cart[p.productId]; });
        return el('div', { class: 'row panel' }, [el('div', {}, [el('strong', { text: p.name }), el('div', { class: 'note', text: '₹' + p.unitPriceExGst + ' + GST ' + p.gstRate + '% · MRP ₹' + p.mrp + (p.available != null ? ' · in stock ' + p.available : '') })]), qty]);
      }));
    }).catch(function (x) { out.replaceChildren(msg(offline(x) ? 'warn' : 'err', offline(x) ? 'Offline: the price list needs a connection. Try again when you have signal.' : x.message)); });
    var pay = el('select', { 'aria-label': 'Payment' }, [['upi', 'UPI'], ['bank_transfer', 'Bank transfer'], ['credit', 'Credit']].map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
    var key = uuid();
    main.appendChild(el('div', { class: 'row' }, [pay, btn('Send code to retailer', function () {
      var lines = Object.keys(cart).map(function (id) { return { productId: Number(id), qty: cart[id] }; });
      if (!lines.length) { out.replaceChildren(msg('err', 'Add at least one item')); return; }
      var body = { retailerId: a.id, paymentMethod: pay.value, clientUuid: key, items: lines };
      sendOrQueue('field_order', '/api/sales/orders', body, 'Order for ' + (a.shop_name || a.business_name), key, function (o) { confirm(o, out); }, out)
        .catch(function (x) { out.replaceChildren(msg('err', x.message + (x.data && x.data.items ? ' — ' + x.data.items.map(function (i) { return i.error; }).join('; ') : ''))); });
    }, 'primary')]));
    root.replaceChildren(el('div', { class: 'shell' }, [main]));
  }

  function confirm(o, out) {
    var code = el('input', { inputmode: 'numeric', autocomplete: 'one-time-code', 'aria-label': 'Code from the retailer', maxlength: '8' });
    var box = el('div', { class: 'panel' }, [el('h2', { text: 'Order ' + o.orderNo + ' · ₹' + o.grandTotal }),
      o.delivery === 'queued' ? el('p', { text: 'Ask the retailer for the code sent to ' + o.codeSentTo + '.' }) : msg('warn', o.note || 'The code could not be sent.'),
      el('div', { class: 'row' }, [code, btn('Confirm order', function () {
        api('POST', '/api/sales/orders/' + o.orderId + '/otp/verify', { code: code.value }).then(function (r) { out.replaceChildren(msg('ok', 'Order confirmed: ' + r.status.replace(/_/g, ' '))); })
          .catch(function (x) { box.appendChild(msg('err', x.message + (x.data && x.data.attemptsLeft != null ? ' (' + x.data.attemptsLeft + ' tries left)' : ''))); });
      }, 'primary'), btn('Resend', function () { api('POST', '/api/sales/orders/' + o.orderId + '/otp/resend', {}).then(function (r) { box.appendChild(msg(r.resent ? 'ok' : 'warn', r.resent ? 'Sent again' : 'Not sent: no WhatsApp sender')); }).catch(function (x) { box.appendChild(msg('err', x.message)); }); }),
      btn('Ask approver to override', function () {
        var why = window.prompt('Why can the retailer not give the code?'); if (!why) return;
        api('POST', '/api/sales/orders/' + o.orderId + '/otp-override', { reason: why }).then(function () { box.appendChild(msg('ok', 'Sent to an approver')); }).catch(function (x) { box.appendChild(msg('err', x.message)); });
      })])]);
    out.replaceChildren(box);
  }

  // ── Event counter (3b.5): sells online, or keeps the sale for sending when offline ──
  function counter(ev) {
    var main = el('main', { id: 'main' }, [el('h1', { text: ev.code + ' counter' }), btn('← Back', start)]);
    var out = el('div'), items = el('div'), lines = {}, key = uuid();
    main.appendChild(queuePanel()); main.appendChild(out); main.appendChild(items);
    var cacheKey = 'soh.eventstock.' + ev.id;
    function drawStock(stock, cached) {
      if (cached) items.appendChild(msg('warn', 'Offline: prices from ' + new Date(stock.at).toLocaleString() + '. Stock is checked again when the sale is sent; if it ran out, the office settles it.'));
      stock.items.forEach(function (p) {
        var q = el('input', { inputmode: 'numeric', 'aria-label': 'Quantity of ' + p.name, placeholder: '0', style: 'width:80px' });
        q.addEventListener('input', function () { var n = parseInt(q.value, 10); if (n > 0) lines[p.productId] = n; else delete lines[p.productId]; total(); });
        items.appendChild(el('div', { class: 'row panel' }, [el('div', {}, [el('strong', { text: p.name }), el('div', { class: 'note', text: money(p.mrp) + ' incl. GST ' + p.gstRate + '% · ' + p.available + ' here' + (p.nextExpiry ? ' · next expiry ' + String(p.nextExpiry).slice(0, 10) : '') })]), q]));
      });
      var byId = {}; stock.items.forEach(function (p) { byId[p.productId] = p; });
      function total() { var t = 0; Object.keys(lines).forEach(function (k) { t += byId[k].mrp * lines[k]; }); sum.textContent = 'Total ' + money(t); }
      var sum = el('strong', { text: 'Total ₹0.00' });
      var cn = el('input', { 'aria-label': 'Customer name', placeholder: 'Customer name (optional)' }), cm = el('input', { 'aria-label': 'Customer mobile', inputmode: 'tel', placeholder: 'Mobile for the invoice (optional)' });
      var pm = el('select', { 'aria-label': 'Paid by' }, [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['', 'Not paid yet']].map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
      main.appendChild(el('div', { class: 'panel' }, [sum, el('div', { class: 'row' }, [cn, cm]), el('div', { class: 'row' }, [pm, btn('Confirm sale', function () {
        var its = Object.keys(lines).map(function (k) { return { productId: Number(k), qty: lines[k] }; });
        if (!its.length) { out.replaceChildren(msg('err', 'Enter a quantity.')); return; }
        var grand = 0; its.forEach(function (i) { grand += byId[i.productId].mrp * i.qty; });
        var body = { idempotencyKey: key, eventId: ev.id, items: its, customer: { name: cn.value, mobile: cm.value }, soldAt: new Date().toISOString(),
          payments: pm.value ? [{ method: pm.value, amount: Math.round(grand) }] : [] };
        sendOrQueue('event_sale', '/api/erp/events/sales', body, 'Sale at ' + ev.code + ' (' + money(grand) + ')', key, function (s) {
          out.replaceChildren(msg('ok', 'Invoice ' + s.invoiceNo + ' · ' + money(s.totals.grand) + (s.duplicate ? ' (already recorded)' : '')));
          setTimeout(function () { counter(ev); }, 1500);
        }, out).then(function () { key = uuid(); lines = {}; });
      }, 'primary')])]));
    }
    api('GET', '/api/erp/events/' + ev.id + '/stock').then(function (s) {
      try { localStorage.setItem(cacheKey, JSON.stringify({ at: new Date().toISOString(), items: s.items })); } catch (e) { /* convenience copy only */ }
      drawStock(s);
    }).catch(function (x) {
      var c = null; try { c = JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch (e) { /* */ }
      if (offline(x) && c) drawStock(c, true); else out.replaceChildren(msg('err', offline(x) ? 'Offline and no price list saved on this phone yet: open the counter once with a connection.' : x.message));
    });
    root.replaceChildren(el('div', { class: 'shell' }, [main]));
  }

  function start() {
    if (!token) { root.replaceChildren(login()); return; }
    Q.init(function () { return token; });
    who = { salesman: null, events: [] };
    Promise.all([
      api('GET', '/api/sales/me').catch(function (x) { if (x.code === 'not_salesman' || x.status === 403) return null; throw x; }),
      api('GET', '/api/erp/events').then(function (r) { return r.items.filter(function (e) { return e.status !== 'closed'; }); }).catch(function (x) { if (x.status === 403) return []; throw x; }),
    ]).then(function (x) {
      who.salesman = x[0]; who.events = x[1];
      if (!who.salesman && !who.events.length) { root.replaceChildren(login('This account is not set up as a salesman or for any event.')); return; }
      home();
    }).catch(function (x) {
      if (offline(x)) { root.replaceChildren(el('div', { class: 'shell' }, [el('main', { id: 'main' }, [msg('warn', 'Offline. Saved work is kept on this phone and sent when the connection returns.'), queuePanel(), btn('Try again', start)])])); return; }
      logout();
    });
  }
  start();
})();
