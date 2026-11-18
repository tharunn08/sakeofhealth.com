(function () {
  'use strict';
  var A = window.Admin;
  if (!A.initShell('reviews', 'Reviews')) return;

  var content = document.getElementById('content');
  var state = { status: 'pending', reviews: [], stats: {} };

  var TABS = [
    { id: 'pending', label: 'Pending' },
    { id: 'approved', label: 'Approved' },
    { id: 'rejected', label: 'Rejected' },
    { id: '', label: 'All' },
  ];

  function shell() {
    content.innerHTML =
      '<div class="stat-grid" id="stats"></div>' +
      '<div class="toolbar"><div class="tabs" id="tabs">' + TABS.map(function (t) {
        return '<button class="tab' + (state.status === t.id ? ' active' : '') +
          '" data-s="' + t.id + '">' + A.esc(t.label) + '</button>';
      }).join('') + '</div></div>' +
      '<div id="host">' + A.loadingState() + '</div>';

    document.getElementById('tabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-s]'); if (!b) return;
      state.status = b.dataset.s; shell(); load();
    });
  }

  function render() {
    document.getElementById('stats').innerHTML =
      '<div class="stat amber"><div class="stat-label">Awaiting Approval</div><div class="stat-value">' +
        (state.stats.pending || 0) + '</div></div>' +
      '<div class="stat"><div class="stat-label">Published</div><div class="stat-value">' +
        (state.stats.approved || 0) + '</div></div>' +
      '<div class="stat violet"><div class="stat-label">Average Rating</div><div class="stat-value">' +
        (state.stats.avgRating || 0) + '<span style="font-size:15px;color:var(--ink-3)"> / 5</span></div></div>' +
      '<div class="stat teal"><div class="stat-label">Total Reviews</div><div class="stat-value">' +
        (state.stats.total || 0) + '</div></div>';

    var host = document.getElementById('host');
    if (!state.reviews.length) {
      host.innerHTML = '<div class="card"><div class="card-body">' +
        A.emptyState('reviews', 'No reviews here',
          'Customer reviews submitted on product pages appear here for moderation.') + '</div></div>';
      return;
    }

    host.innerHTML = state.reviews.map(function (r) {
      var status = r.status || 'pending';
      return '<div class="card mb-16"><div class="card-body">' +
        '<div class="flex items-center gap-12 mb-16" style="flex-wrap:wrap">' +
          '<div class="sb-avatar">' + A.esc(A.fmt.initials(r.name)) + '</div>' +
          '<div style="flex:1;min-width:140px"><div class="td-strong">' + A.esc(r.name) +
            (r.city ? ' · <span class="td-muted">' + A.esc(r.city) + '</span>' : '') + '</div>' +
            '<div class="td-muted">' + A.esc(r.productName || 'Product') + ' · ' +
            A.esc(A.fmt.relative(r.createdAt)) + '</div></div>' +
          '<span class="rating-stars">' + A.fmt.stars(r.rating) + '</span>' +
          (r.verified ? '<span class="badge badge-delivered">Verified buyer</span>' : '') +
          '<span class="badge badge-' + (status === 'approved' ? 'delivered' : status === 'rejected' ? 'cancelled' : 'pending') + '">' +
            A.esc(status) + '</span>' +
        '</div>' +
        (r.title ? '<div class="td-strong mb-16">' + A.esc(r.title) + '</div>' : '') +
        '<p style="color:var(--ink-2);line-height:1.65;margin-bottom:16px">' + A.esc(r.body) + '</p>' +
        (r.photo ? '<img src="' + A.esc(r.photo) + '" alt="Customer photo" ' +
          'style="max-width:220px;max-height:220px;border-radius:12px;margin-bottom:16px;display:block;border:1px solid var(--line-2)"/>' : '') +
        (r.reply ? '<div class="info-box mb-16"><strong>Your reply</strong>' + A.esc(r.reply) + '</div>' : '') +
        '<div class="flex gap-8" style="flex-wrap:wrap">' +
          (status !== 'approved'
            ? '<button class="btn btn-primary btn-sm" data-approve="' + A.esc(r.id) + '">' + A.icon('check') + 'Approve</button>' : '') +
          (status !== 'rejected'
            ? '<button class="btn btn-ghost btn-sm" data-reject="' + A.esc(r.id) + '">Reject</button>' : '') +
          '<button class="btn btn-ghost btn-sm" data-reply="' + A.esc(r.id) + '">' +
            (r.reply ? 'Edit reply' : 'Reply') + '</button>' +
          '<div class="spacer" style="flex:1"></div>' +
          '<button class="btn btn-danger-ghost btn-sm" data-del="' + A.esc(r.id) + '">' + A.icon('trash') + '</button>' +
        '</div></div></div>';
    }).join('');

    host.querySelectorAll('[data-approve]').forEach(function (b) {
      b.addEventListener('click', function () { setStatus(b.dataset.approve, 'approved'); });
    });
    host.querySelectorAll('[data-reject]').forEach(function (b) {
      b.addEventListener('click', function () { setStatus(b.dataset.reject, 'rejected'); });
    });
    host.querySelectorAll('[data-reply]').forEach(function (b) {
      b.addEventListener('click', function () { reply(b.dataset.reply); });
    });
    host.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () { del(b.dataset.del); });
    });
  }

  async function setStatus(id, status) {
    try {
      await A.api.patch('/reviews/' + id, { status: status });
      A.toast(status === 'approved' ? 'Review published to your site' : 'Review rejected', 'success');
      load(); A.loadBadges();
    } catch (e) { A.toast(e.message, 'error'); }
  }

  async function reply(id) {
    var r = state.reviews.find(function (x) { return x.id === id; });
    var text = prompt('Your public reply to this review:', (r && r.reply) || '');
    if (text === null) return;
    try {
      await A.api.patch('/reviews/' + id, { reply: text.trim() });
      A.toast('Reply saved', 'success');
      load();
    } catch (e) { A.toast(e.message, 'error'); }
  }

  async function del(id) {
    if (!confirm('Delete this review permanently?')) return;
    try {
      await A.api.del('/reviews/' + id);
      A.toast('Review deleted', 'success');
      load(); A.loadBadges();
    } catch (e) { A.toast(e.message, 'error'); }
  }

  async function load() {
    try {
      var d = await A.api.get('/reviews' + (state.status ? '?status=' + state.status : ''));
      state.reviews = d.reviews; state.stats = d.stats;
      render();
    } catch (e) {
      document.getElementById('host').innerHTML =
        '<div class="alert alert-error">' + A.icon('alert') + '<span>' + A.esc(e.message) + '</span></div>';
    }
  }

  shell();
  load();
})();
