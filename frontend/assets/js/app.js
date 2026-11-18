/* Sake of Health — shared app utilities */
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

(function () {
  'use strict';

  /* ── Cart (localStorage) ── */
  window.sohCart = {
    KEY: 'soh_cart',
    get() { try { return JSON.parse(localStorage.getItem(this.KEY) || '[]'); } catch { return []; } },
    save(c) { localStorage.setItem(this.KEY, JSON.stringify(c)); this.updateBadge(); },
    add(item) {
      const c = this.get();
      const idx = c.findIndex(i => i.id === item.id);
      if (idx >= 0) c[idx].qty = (c[idx].qty || 1) + 1;
      else c.push({ id: item.id, name: item.name, price: item.price, image: item.image || '', qty: 1 });
      this.save(c);
      window.sohTrack && sohTrack('add_to_cart', { product: item.id, price: item.price, currency: 'INR' });
      this.showToast(item.name);
    },
    remove(id) { this.save(this.get().filter(i => i.id !== id)); },
    updateQty(id, qty) {
      const c = this.get().map(i => i.id === id ? { ...i, qty: Math.max(1, qty) } : i);
      this.save(c);
    },
    clear() { localStorage.removeItem(this.KEY); this.updateBadge(); },
    count() { return this.get().reduce((s, i) => s + (i.qty || 1), 0); },
    total() { return this.get().reduce((s, i) => s + i.price * (i.qty || 1), 0); },
    updateBadge() {
      const n = this.count();
      document.querySelectorAll('.cart-count').forEach(el => {
        el.textContent = n;
        el.style.display = n > 0 ? 'flex' : 'none';
      });
    },
    showToast(name) {
      const t = document.createElement('div');
      t.className = 'soh-toast';
      t.innerHTML = `<span>✓</span> <strong>${name}</strong> added to cart`;
      document.body.appendChild(t);
      requestAnimationFrame(() => t.classList.add('show'));
      setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2800);
    },
  };

  /* ── Reveal on scroll ── */
  window.sohReveal = function () {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: 0.05, rootMargin: '0px 0px -20px 0px' });
    document.querySelectorAll('.reveal').forEach(el => {
      const r = el.getBoundingClientRect();
      // Immediately reveal elements already in viewport (no animation delay for above-fold)
      if (r.top < window.innerHeight && r.bottom > 0) {
        el.classList.add('in');
      } else {
        io.observe(el);
      }
    });
  };

  /* ── FAQ accordion ── */
  window.sohFAQ = function () {
    document.querySelectorAll('.faq-q').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = btn.closest('.faq-item');
        const open = item.classList.contains('open');
        document.querySelectorAll('.faq-item.open').forEach(i => {
          i.classList.remove('open');
          i.querySelector('.faq-a').style.maxHeight = null;
        });
        if (!open) { item.classList.add('open'); item.querySelector('.faq-a').style.maxHeight = item.querySelector('.faq-a').scrollHeight + 'px'; }
      });
    });
  };

  /* ── Nav scroll shadow ── */
  window.sohNav = function () {
    const nav = document.querySelector('.site-nav');
    if (!nav) return;
    const update = () => nav.classList.toggle('scrolled', window.scrollY > 40);
    window.addEventListener('scroll', update, { passive: true });
    update();
  };

  /* ── Page entry animation ── */
  window.sohPageEnter = function () {
    document.body.classList.add('page-enter');
  };

  /* ── Add to cart helper (call from product pages) ── */
  window.sohAddToCart = function (id, name, price, image) {
    sohCart.add({ id, name, price, image });
  };

  /* ── Go to checkout ── */
  window.sohBuyNow = function (id, name, price, image) {
    sohCart.clear();
    sohCart.add({ id, name, price, image });
    window.location.href = '/checkout/';
  };

  /* ── Auto init ── */
  document.addEventListener('DOMContentLoaded', () => {
    sohCart.updateBadge();
    sohReveal();
    sohFAQ();
    sohNav();
    sohPageEnter();
  });
})();
