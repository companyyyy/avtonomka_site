/**
 * cart.js - кошик покупця (localStorage) + floating-кнопка й дровер перегляду.
 * Підключений глобально (через main.js include на всіх сторінках).
 *
 * Кнопки додавання в кошик - звичайні <button data-add-to-cart data-id=".."
 * data-title=".." data-price=".." data-sku=".."> у статичній розмітці карток
 * товару й сторінки товару (не домальовуються JS), щоб кнопка була видна
 * будь-якому боту одразу в HTML.
 *
 * Саме оформлення (контакти, місто/відділення Нової Пошти, згода з
 * політикою конфіденційності) відбувається на окремій сторінці checkout.html
 * (assets/js/checkout.js), яка надсилає кошик у той самий Google Apps Script,
 * що приймає заявки з assets/js/order-form.js (scripts/order_form_apps_script.gs).
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'avtonomka_cart';

  /* Сторінки в /product/ та /catalog/ лежать на рівень глибше кореня сайту */
  function getBase() {
    const path = window.location.pathname;
    const depth = path.split('/').length - 2;
    return depth >= 1 && (path.includes('/catalog/') || path.includes('/product/')) ? '../'.repeat(depth) : '';
  }
  const BASE = getBase();

  function readCart() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const items = raw ? JSON.parse(raw) : [];
      return Array.isArray(items) ? items : [];
    } catch (e) {
      return [];
    }
  }

  function writeCart(items) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    updateBadge();
    renderDrawerItems();
  }

  function addItem(item) {
    if (!item || !item.id) return;
    const items = readCart();
    const existing = items.find(i => i.id === item.id);
    if (existing) {
      existing.qty += 1;
    } else {
      items.push({
        id: item.id,
        title: item.title || '',
        price: parseFloat(item.price) || 0,
        currency: item.currency || 'UAH',
        sku: item.sku || '',
        qty: 1
      });
    }
    writeCart(items);
    flashFab();
  }

  function removeItem(id) {
    writeCart(readCart().filter(i => i.id !== id));
  }

  function setQty(id, qty) {
    qty = Math.max(1, Math.floor(qty) || 1);
    const items = readCart();
    const item = items.find(i => i.id === id);
    if (!item) return;
    item.qty = qty;
    writeCart(items);
  }

  function clearCart() {
    writeCart([]);
  }

  function getCount() {
    return readCart().reduce((sum, i) => sum + i.qty, 0);
  }

  function getTotal() {
    return readCart().reduce((sum, i) => sum + i.price * i.qty, 0);
  }

  function formatPrice(num, currency) {
    return Math.round(num).toLocaleString('uk-UA', { maximumFractionDigits: 0 }) + ' ' + (currency || 'UAH');
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ============================================================
     UI: floating button + drawer (перегляд кошика)
     ============================================================ */

  const UI_HTML = `
    <button type="button" id="cart-fab" class="cart-fab hidden" aria-label="Кошик">
      🛒<span id="cart-fab-count" class="cart-fab__count hidden">0</span>
    </button>

    <div id="cart-drawer-overlay" class="cart-drawer-overlay hidden">
      <div class="cart-drawer" role="dialog" aria-modal="true" aria-labelledby="cart-drawer-title">
        <button type="button" class="cart-drawer-close" aria-label="Закрити">&times;</button>
        <h3 id="cart-drawer-title">Кошик</h3>

        <div id="cart-drawer-items" class="cart-drawer-items"></div>
        <p id="cart-drawer-empty" class="cart-drawer-empty hidden">Кошик порожній</p>

        <div id="cart-drawer-footer" class="cart-drawer-footer hidden">
          <div class="cart-drawer-total">Разом: <strong id="cart-drawer-total">0 UAH</strong></div>
          <a href="${BASE}checkout.html" class="btn btn-primary btn-block" id="cart-drawer-checkout">Оформити замовлення</a>
        </div>
      </div>
    </div>`;

  let fab, fabCount, overlay, itemsWrap, emptyBlock, footerBlock, totalEl;

  function buildUi() {
    document.body.insertAdjacentHTML('beforeend', UI_HTML);

    fab           = document.getElementById('cart-fab');
    fabCount      = document.getElementById('cart-fab-count');
    overlay       = document.getElementById('cart-drawer-overlay');
    itemsWrap     = document.getElementById('cart-drawer-items');
    emptyBlock    = document.getElementById('cart-drawer-empty');
    footerBlock   = document.getElementById('cart-drawer-footer');
    totalEl       = document.getElementById('cart-drawer-total');

    fab.addEventListener('click', openDrawer);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeDrawer();
    });
    overlay.querySelector('.cart-drawer-close').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeDrawer();
    });

    itemsWrap.addEventListener('click', function (e) {
      const removeBtn = e.target.closest('[data-cart-remove]');
      if (removeBtn) {
        removeItem(removeBtn.getAttribute('data-cart-remove'));
        return;
      }
      const stepBtn = e.target.closest('[data-cart-step]');
      if (stepBtn) {
        const id = stepBtn.getAttribute('data-cart-id');
        const item = readCart().find(i => i.id === id);
        if (!item) return;
        const delta = parseInt(stepBtn.getAttribute('data-cart-step'), 10);
        setQty(id, item.qty + delta);
      }
    });

    itemsWrap.addEventListener('change', function (e) {
      const input = e.target.closest('[data-cart-qty-input]');
      if (!input) return;
      setQty(input.getAttribute('data-cart-qty-input'), parseInt(input.value, 10));
    });
  }

  function renderDrawerItems() {
    if (!itemsWrap) return;
    const items = readCart();

    if (items.length === 0) {
      itemsWrap.innerHTML = '';
      emptyBlock.classList.remove('hidden');
      footerBlock.classList.add('hidden');
      return;
    }

    emptyBlock.classList.add('hidden');
    footerBlock.classList.remove('hidden');

    itemsWrap.innerHTML = items.map(item => `
      <div class="cart-item">
        <div class="cart-item__info">
          <div class="cart-item__title">${escapeHtml(item.title)}</div>
          ${item.sku ? `<div class="cart-item__sku">Арт. ${escapeHtml(item.sku)}</div>` : ''}
          <div class="cart-item__price">${formatPrice(item.price, item.currency)}</div>
        </div>
        <div class="cart-item__controls">
          <div class="cart-item__qty">
            <button type="button" data-cart-step="-1" data-cart-id="${escapeHtml(item.id)}" aria-label="Зменшити">−</button>
            <input type="number" min="1" value="${item.qty}" data-cart-qty-input="${escapeHtml(item.id)}" aria-label="Кількість">
            <button type="button" data-cart-step="1" data-cart-id="${escapeHtml(item.id)}" aria-label="Збільшити">+</button>
          </div>
          <button type="button" class="cart-item__remove" data-cart-remove="${escapeHtml(item.id)}" aria-label="Видалити">Видалити</button>
        </div>
      </div>`).join('');

    totalEl.textContent = formatPrice(getTotal(), items[0].currency);
  }

  function updateBadge() {
    if (!fab) return;
    const count = getCount();
    fab.classList.toggle('hidden', count === 0);
    fabCount.textContent = String(count);
    fabCount.classList.toggle('hidden', count === 0);
  }

  function flashFab() {
    if (!fab) return;
    fab.classList.add('cart-fab--flash');
    setTimeout(function () { fab.classList.remove('cart-fab--flash'); }, 350);
  }

  function showCart() {
    itemsWrap.classList.remove('hidden');
    footerBlock.classList.toggle('hidden', readCart().length === 0);
    if (readCart().length === 0) emptyBlock.classList.remove('hidden');
  }

  function openDrawer() {
    if (!overlay) buildUi();
    renderDrawerItems();
    showCart();
    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeDrawer() {
    if (!overlay) return;
    overlay.classList.add('hidden');
    document.body.style.overflow = '';
  }

  function wireAddButtons() {
    document.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-add-to-cart]');
      if (!btn) return;
      e.preventDefault();
      const id = btn.getAttribute('data-id');
      if (!id) return;
      addItem({
        id: id,
        title: btn.getAttribute('data-title') || '',
        price: btn.getAttribute('data-price') || '0',
        currency: btn.getAttribute('data-currency') || 'UAH',
        sku: btn.getAttribute('data-sku') || ''
      });
      openDrawer();
    });
  }

  /* ---- Надсилання замовлення (checkout.js, order-form.js) ----
     Основне - Supabase (Edge Function order-submit -> таблиці orders,
     розділ «Замовлення» адмінки, сповіщення менеджеру в Telegram).
     Запасна копія - Google Таблиця (Apps Script, no-cors: відповідь не
     читається). Замовлення вважається надісланим, якщо його прийняла хоч
     одна сторона. Повертає { number } (номер з Supabase або null). */
  const ORDER_API = 'https://uvndubhmqzqqsrnrxgaj.supabase.co/functions/v1/order-submit';
  const ORDER_SHEET = 'https://script.google.com/macros/s/AKfycbz7JbuQpZmBlUck24Bjp7SGKZL-JqE_clqLuYb9y15QG4-FSk45ZkpPHf5faZWISHcE/exec';

  function newOrderKey() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  function submitOrder(order, sheetData) {
    const sheet = fetch(ORDER_SHEET, { method: 'POST', mode: 'no-cors', body: sheetData })
      .then(function () { return true; }, function () { return false; });
    const ctrl = window.AbortController ? new AbortController() : null;
    const timer = ctrl && setTimeout(function () { ctrl.abort(); }, 20000);
    const api = fetch(ORDER_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ page_url: location.href }, order)),
      signal: ctrl ? ctrl.signal : undefined
    })
      .then(function (r) { return r.json().then(function (j) { return r.ok && j && j.ok ? j : null; }); })
      .catch(function (err) { console.error('Orders: Supabase', err); return null; })
      .finally(function () { if (timer) clearTimeout(timer); });
    return Promise.all([api, sheet]).then(function (res) {
      if (!res[0] && !res[1]) throw new Error('order not sent');
      return { number: res[0] ? res[0].number : null };
    });
  }

  window.Orders = { submit: submitOrder, newKey: newOrderKey };

  window.Cart = {
    add: addItem,
    remove: removeItem,
    setQty: setQty,
    clear: clearCart,
    getAll: readCart,
    getCount: getCount,
    getTotal: getTotal,
    open: openDrawer,
    close: closeDrawer
  };

  function init() {
    buildUi();
    updateBadge();
    wireAddButtons();
    window.addEventListener('storage', function (e) {
      if (e.key === STORAGE_KEY) {
        updateBadge();
        renderDrawerItems();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
