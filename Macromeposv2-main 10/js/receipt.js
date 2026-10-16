/*! receipt.js - receipt printing for web POS apps. No dependencies.
 *
 *  Route A  printHTML / printElement : any printer with an OS driver (hidden iframe, thermal CSS)
 *  Route B  buildEscPos / printRaw   : raw ESC/POS over WebUSB, Web Serial or Web Bluetooth
 *
 *  Exposes window.NotifyReceipt. Edit `config` below (shop details, paper width, columns).
 *  Never put the closing script tag in this file - it is inlined into HTML by the patcher.
 */
(function (root) {
  'use strict';

  var config = {
    shop: {
      name: 'NOTIFY MOTORCYCLE SPARES',
      lines: ['Chuka Town, Chuka-Kathituni Rd', 'Opp. Chuka Boys High School', 'Tel: 0718 333 885'],
      footer: ['Thank you for your business!', 'Safe riding!']
    },
    currency: 'KES',
    paperMm: 80,       // 80 or 58 (browser printing width)
    cols: 42,          // ESC/POS characters per line: 58mm -> 32, 80mm -> 42 (48 on some printers)
    cut: true,         // cut paper after the receipt
    openDrawer: false, // pulse the cash drawer on cash sales
    baudRate: 9600,    // Web Serial only
    bleChunk: 100      // Web Bluetooth write size; use 20 if output is garbled or truncated
  };

  /* ---------- text helpers (shared) ---------- */

  // Raw printers use a single-byte code page; strip everything outside printable ASCII.
  function ascii(s) {
    return String(s == null ? '' : s)
      .replace(/[\u2013\u2014\u2212]/g, '-')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\u00A0/g, ' ')
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\x20-\x7E]/g, '');
  }

  function money(n) {
    return (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function two(n) { return (n < 10 ? '0' : '') + n; }

  function fmtDate(d) {
    if (isNaN(d.getTime())) d = new Date();
    return {
      date: two(d.getDate()) + '/' + two(d.getMonth() + 1) + '/' + d.getFullYear(),
      time: two(d.getHours()) + ':' + two(d.getMinutes())
    };
  }

  // "left ........ right" on exactly `cols` characters; the left side is trimmed if needed.
  function pad(left, right, cols) {
    left = ascii(left); right = ascii(right);
    var room = Math.max(1, cols - right.length - 1);
    if (left.length > room) left = left.slice(0, room);
    return left + new Array(Math.max(1, cols - left.length - right.length) + 1).join(' ') + right;
  }

  function wrap(text, cols) {
    var out = [], line = '';
    ascii(text).split(/\s+/).filter(Boolean).forEach(function (w) {
      while (w.length > cols) {
        if (line) { out.push(line); line = ''; }
        out.push(w.slice(0, cols));
        w = w.slice(cols);
      }
      if (!line) line = w;
      else if ((line + ' ' + w).length <= cols) line += ' ' + w;
      else { out.push(line); line = w; }
    });
    if (line) out.push(line);
    return out.length ? out : [''];
  }

  /* ---------- Route A: browser / OS printing ---------- */

  // Prints markup through a hidden iframe. Unlike window.open() popups it is not blocked,
  // and it clones the page's own <style>/<link> tags so utility classes (Tailwind etc.)
  // keep working - a popup with a hand-written stylesheet silently loses them.
  function printHTML(html, opts) {
    opts = opts || {};
    var mm = opts.paperMm || config.paperMm;
    var width = mm === 58 ? '48mm' : '72mm'; // printable width is a little under the roll width
    var head = '<base href="' + document.baseURI + '">';
    Array.prototype.forEach.call(document.querySelectorAll('style'), function (s) {
      head += '<style>' + s.textContent + '</style>';
    });
    Array.prototype.forEach.call(document.querySelectorAll('link[rel="stylesheet"]'), function (l) {
      head += l.outerHTML;
    });
    head += '<style>' +
      '@page{margin:0}' +
      'html,body{margin:0;padding:0;background:#fff!important;color:#000!important}' +
      'body{box-sizing:border-box;width:' + width + ';padding:1mm 1mm 8mm;' +
      'font-family:"Courier New",ui-monospace,monospace;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      '</style>';

    var f = document.createElement('iframe');
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    var done = false;
    function cleanup() {
      if (done) return;
      done = true;
      setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 500);
    }
    f.onload = function () {
      try {
        f.contentWindow.focus();
        f.contentWindow.onafterprint = cleanup;
        f.contentWindow.print();
      } finally {
        setTimeout(cleanup, 60000); // Safari/Firefox print asynchronously; do not remove early
      }
    };
    f.srcdoc = '<!doctype html><html><head><meta charset="utf-8">' + head + '</head><body>' + html + '</body></html>';
    document.body.appendChild(f);
  }

  function printElement(el) {
    if (!el) return;
    printHTML(el.outerHTML);
  }

  /* ---------- Route B: ESC/POS ---------- */

  var ESC = 0x1b, GS = 0x1d;

  function Enc(cols) { this.cols = cols; this.b = []; }
  Enc.prototype.raw = function () { for (var i = 0; i < arguments.length; i++) this.b.push(arguments[i] & 0xff); return this; };
  Enc.prototype.text = function (s) { s = ascii(s); for (var i = 0; i < s.length; i++) this.b.push(s.charCodeAt(i)); return this; };
  Enc.prototype.line = function (s) { return this.text(s || '').raw(0x0a); };
  Enc.prototype.align = function (n) { return this.raw(ESC, 0x61, n); };                 // 0 left, 1 centre, 2 right
  Enc.prototype.bold = function (on) { return this.raw(ESC, 0x45, on ? 1 : 0); };
  Enc.prototype.size = function (w, h) { return this.raw(GS, 0x21, ((w - 1) << 4) | (h - 1)); }; // 1..8 each
  Enc.prototype.rule = function (ch) { return this.line(new Array(this.cols + 1).join(ch || '-')); };
  Enc.prototype.feed = function (n) { return this.raw(ESC, 0x64, n); };
  Enc.prototype.cut = function () { return this.feed(3).raw(GS, 0x56, 0x42, 0x00); };    // feed, then partial cut
  Enc.prototype.drawer = function () { return this.raw(ESC, 0x70, 0x00, 0x19, 0xfa); };  // cash drawer pin 2
  Enc.prototype.bytes = function () { return new Uint8Array(this.b); };

  // sale = { receiptNumber, cashierName, items:[{product:{name,sellingPrice},quantity}],
  //          subtotal, discount, total, paymentMethod, amountPaid, change, date }
  // Note: item.discount is deliberately ignored - the POS only applies a sale-level discount,
  // and subtracting both would double count.
  function buildEscPos(sale, opts) {
    var cfg = {}, k;
    for (k in config) cfg[k] = config[k];
    for (k in (opts || {})) cfg[k] = opts[k];
    var cols = cfg.cols, cur = cfg.currency, shop = cfg.shop, e = new Enc(cols);
    var when = fmtDate(new Date(sale.date));
    var isCash = String(sale.paymentMethod).toLowerCase() === 'cash';

    e.raw(ESC, 0x40);                                   // initialise printer
    e.align(1).bold(true);
    wrap(shop.name, cols).forEach(function (l) { e.line(l); });
    e.bold(false);
    shop.lines.forEach(function (l) { wrap(l, cols).forEach(function (x) { e.line(x); }); });
    if (sale.shopName) { e.bold(true); wrap(sale.shopName + (sale.shopLoc ? ' - ' + sale.shopLoc : ''), cols).forEach(function (l) { e.line(l); }); e.bold(false); }
    e.align(0).rule();
    e.line(pad('Receipt:', sale.receiptNumber, cols));
    e.line(pad('Date:', when.date, cols));
    e.line(pad('Time:', when.time, cols));
    e.line(pad('Cashier:', sale.cashierName, cols));
    e.rule();

    (sale.items || []).forEach(function (it) {
      var p = it.product || {}, qty = Number(it.quantity) || 0, unit = Number(p.sellingPrice) || 0;
      wrap(p.name, cols).forEach(function (l) { e.line(l); });
      e.line(pad('  ' + qty + ' x ' + money(unit), money(unit * qty), cols));
    });

    e.rule();
    e.line(pad('Subtotal:', cur + ' ' + money(sale.subtotal), cols));
    if (Number(sale.discount) > 0) e.line(pad('Discount:', '-' + cur + ' ' + money(sale.discount), cols));
    e.bold(true).size(1, 2).line(pad('TOTAL:', cur + ' ' + money(sale.total), cols)).size(1, 1).bold(false);
    e.line(pad('Payment:', String(sale.paymentMethod || '').toUpperCase(), cols));
    if (sale.reference) e.line(pad('Ref:', sale.reference, cols));
    if (isCash && sale.amountPaid != null) {
      e.line(pad('Paid:', cur + ' ' + money(sale.amountPaid), cols));
      e.line(pad('Change:', cur + ' ' + money(sale.change), cols));
    }
    e.rule();
    e.align(1);
    (shop.footer || []).forEach(function (l) { wrap(l, cols).forEach(function (x) { e.line(x); }); });
    e.align(0);
    if (cfg.openDrawer && isCash) e.drawer();
    if (cfg.cut) e.cut(); else e.feed(4);
    return e.bytes();
  }

  /* ---------- transports (need a real printer to verify; Chrome/Edge, secure context) ---------- */

  var BLE_SERVICES = [
    '000018f0-0000-1000-8000-00805f9b34fb',
    '0000ff00-0000-1000-8000-00805f9b34fb',
    '0000fee7-0000-1000-8000-00805f9b34fb',
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    '49535343-fe7d-4ae5-8fa9-9fafd205e455'
  ];

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function connectSerial() {
    if (!navigator.serial) throw new Error('Web Serial is not available in this browser');
    var port = await navigator.serial.requestPort();
    await port.open({ baudRate: config.baudRate });
    var writer = port.writable.getWriter();
    return {
      kind: 'serial',
      write: function (b) { return writer.write(b); },
      close: async function () { try { writer.releaseLock(); await port.close(); } catch (e) { /* ignore */ } }
    };
  }

  async function connectUsb() {
    if (!navigator.usb) throw new Error('WebUSB is not available in this browser');
    var dev = await navigator.usb.requestDevice({ filters: [{ classCode: 7 }] }); // 7 = printer class
    await dev.open();
    if (!dev.configuration) await dev.selectConfiguration(1);
    var iface = null, ep = null;
    dev.configuration.interfaces.some(function (i) {
      var alt = i.alternates.filter(function (a) { return a.interfaceClass === 7; })[0];
      var out = alt && alt.endpoints.filter(function (x) { return x.direction === 'out'; })[0];
      if (!out) return false;
      iface = i; ep = out; return true;
    });
    if (!iface) throw new Error('No printer interface found on this USB device');
    await dev.claimInterface(iface.interfaceNumber);
    return {
      kind: 'usb',
      write: async function (b) {
        for (var i = 0; i < b.length; i += 4096) await dev.transferOut(ep.endpointNumber, b.slice(i, i + 4096));
      },
      close: async function () { try { await dev.close(); } catch (e) { /* ignore */ } }
    };
  }

  async function connectBle() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth is not available in this browser');
    var dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
    var server = await dev.gatt.connect();
    var ch = null, services = await server.getPrimaryServices();
    for (var i = 0; i < services.length && !ch; i++) {
      var chars = await services[i].getCharacteristics();
      for (var j = 0; j < chars.length; j++) {
        if (chars[j].properties.write || chars[j].properties.writeWithoutResponse) { ch = chars[j]; break; }
      }
    }
    if (!ch) throw new Error('No writable Bluetooth characteristic found - printer not supported');
    return {
      kind: 'bluetooth',
      write: async function (b) {
        for (var i = 0; i < b.length; i += config.bleChunk) {
          var part = b.slice(i, i + config.bleChunk);
          if (ch.properties.writeWithoutResponse) await ch.writeValueWithoutResponse(part);
          else await ch.writeValue(part);
          await sleep(15);
        }
      },
      close: async function () { try { dev.gatt.disconnect(); } catch (e) { /* ignore */ } }
    };
  }

  var link = null;

  function available() {
    var a = [];
    if (typeof navigator !== 'undefined') {
      if (navigator.usb) a.push('usb');
      if (navigator.serial) a.push('serial');
      if (navigator.bluetooth) a.push('bluetooth');
    }
    return a;
  }

  function pickKind() {
    var a = available(), saved = null;
    try { saved = localStorage.getItem('nms_printer_kind'); } catch (e) { /* ignore */ }
    if (saved && a.indexOf(saved) > -1) return saved;
    if (!a.length) throw new Error('This browser cannot talk to printers directly. Use Chrome or Edge, or the normal Print button.');
    if (a.length === 1) return a[0];
    var ans = (root.prompt('Printer connection: ' + a.join(' / '), a[0]) || '').toLowerCase().trim();
    if (a.indexOf(ans) < 0) throw Object.assign(new Error('Cancelled'), { name: 'NotFoundError' });
    try { localStorage.setItem('nms_printer_kind', ans); } catch (e) { /* ignore */ }
    return ans;
  }

  async function connect(kind) {
    kind = kind || pickKind();
    link = kind === 'usb' ? await connectUsb() : kind === 'serial' ? await connectSerial() : await connectBle();
    return link;
  }

  async function disconnect() { if (link) { await link.close(); link = null; } }

  async function printRaw(sale, kind) {
    if (!link) await connect(kind);
    try { await link.write(buildEscPos(sale)); }
    catch (err) { link = null; throw err; } // stale connection: reconnect on the next click
  }

  // UI-friendly wrapper: user-cancelled pickers are silent, other failures are shown.
  function printSaleRaw(sale) {
    return printRaw(sale).catch(function (err) {
      if (err && err.name === 'NotFoundError') return;
      root.alert('Thermal print failed: ' + ((err && err.message) || err) +
        '\nTip: use the normal Print button, or check the printer connection.');
    });
  }

  root.NotifyReceipt = {
    config: config, ascii: ascii, money: money, pad: pad, wrap: wrap,
    printHTML: printHTML, printElement: printElement,
    buildEscPos: buildEscPos, connect: connect, disconnect: disconnect,
    printRaw: printRaw, printSaleRaw: printSaleRaw, available: available
  };
})(typeof window !== 'undefined' ? window : globalThis);
