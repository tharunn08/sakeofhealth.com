/**
 * Location Picker — "Share my location" (GPS) + interactive map pin selection.
 * Uses Leaflet + OpenStreetMap (no API key needed).
 *
 * The map is created the first time the panel is shown and invalidateSize() is
 * called on a short retry loop so tiles always paint even when the container was
 * hidden at init (the classic "grey map" bug).
 */
(function () {
  'use strict';

  var LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  var LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
  var DEFAULT_CENTER = [12.9716, 77.5946];

  var leafletPromise = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise(function (resolve, reject) {
      if (!document.querySelector('link[data-leaflet]')) {
        var css = document.createElement('link');
        css.rel = 'stylesheet'; css.href = LEAFLET_CSS;
        css.setAttribute('data-leaflet', '1');
        document.head.appendChild(css);
      }
      var s = document.createElement('script');
      s.src = LEAFLET_JS;
      s.onload = function () { resolve(window.L); };
      s.onerror = function () { reject(new Error('Could not load the map library')); };
      document.head.appendChild(s);
    });
    return leafletPromise;
  }

  function LocationPicker(opts) {
    this.opts = opts || {};
    this.mount = opts.mount;
    this.onSelect = opts.onSelect || function () {};
    this.selected = null;
    this.map = null;
    this.marker = null;
    this.pending = null;
    this.pendingAddress = null;
    this._render();
  }

  LocationPicker.prototype._render = function () {
    var self = this;
    this.mount.innerHTML =
      '<div class="lp-actions">' +
        '<button type="button" class="lp-btn lp-btn-primary" data-lp="gps">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
          'stroke-linecap="round" stroke-linejoin="round" width="16" height="16">' +
          '<path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7"/>' +
          '<circle cx="12" cy="12" r="2.5" fill="currentColor"/></svg>' +
          '<span>Share my location</span>' +
        '</button>' +
      '</div>' +
      '<div class="lp-status" data-lp="status"></div>';

    this.$ = function (name) { return self.mount.querySelector('[data-lp="' + name + '"]'); };

    this.$('gps').addEventListener('click', function () { self.useGPS(); });
  };

  LocationPicker.prototype._status = function (msg, type) {
    var s = this.$('status');
    if (!msg) { s.innerHTML = ''; return; }
    s.innerHTML = '<div class="lp-msg lp-msg-' + (type || 'info') + '">' + msg + '</div>';
  };

  LocationPicker.prototype.useGPS = function () {
    var self = this;
    if (!navigator.geolocation) {
      this._status('Your browser does not support location sharing. Please enter your address manually below.', 'error');
      return;
    }
    var btn = this.$('gps');
    var original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="lp-spin"></span><span>Finding you…</span>';
    this._status('');

    navigator.geolocation.getCurrentPosition(
      async function (pos) {
        btn.disabled = false;
        btn.innerHTML = original;
        await self._resolve(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, 'gps');
      },
      function (err) {
        btn.disabled = false;
        btn.innerHTML = original;
        var msg = 'We could not get your location. Please enter your address manually below.';
        if (err.code === 1) msg = 'Location access was blocked. Enable it in your browser settings, or just type your address below.';
        else if (err.code === 3) msg = 'Finding your location took too long. Please try again or type your address below.';
        self._status(msg, 'error');
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  };

  LocationPicker.prototype._resolve = async function (lat, lng, accuracy, source) {
    this._status('<span class="lp-spin lp-spin-dark"></span> Looking up your area…', 'info');
    try {
      var res = await fetch('/api/shop/geocode/reverse?lat=' + lat + '&lng=' + lng);
      var d = await res.json();
      var result = Object.assign({}, d, { lat: lat, lng: lng, accuracy: accuracy || null, source: source || 'gps' });
      this.selected = result;
      this._showConfirmed(result);
      this.onSelect(result);
    } catch (e) {
      var fallback = { lat: lat, lng: lng, accuracy: accuracy, source: source, formatted: '' };
      this.selected = fallback;
      this._showConfirmed(fallback);
      this.onSelect(fallback);
    }
  };

  LocationPicker.prototype._showConfirmed = function (r) {
    var parts = [r.line1, r.city, r.state, r.pincode].filter(Boolean).join(', ');
    this._status(
      '<div class="lp-confirmed">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
      'stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M20 6 9 17l-5-5"/></svg>' +
      '<div><strong>Location captured — now add your door number below</strong><span>' +
      (parts || r.formatted || (r.lat.toFixed(5) + ', ' + r.lng.toFixed(5))) +
      '</span></div></div>', 'success');
  };

  LocationPicker.prototype.get = function () { return this.selected; };
  window.LocationPicker = LocationPicker;
})();
