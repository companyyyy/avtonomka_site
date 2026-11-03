/* affiliate.js - партнерська програма на сторінках сайту (docs/AFFILIATE.md).

   1. Перехід за посиланням партнера. .htaccess (генерує
      scripts/generate_static_pages.js) робить 301 з «...?ref=КОД» на ту саму
      адресу без ref, з «#aff=КОД» - щоб у пошуку не було дублів сторінок.
      Якщо .htaccess не спрацював, тут же беремо ?ref=КОД з адреси і прибираємо
      його без перезавантаження. Код іде у функцію affiliate (дія click): вона
      пише перехід і повертає підписану cookie aff_ref на cookie_days днів.
      Невалідний / заблокований код функція мовчки ігнорує.
   2. Cookie aff_ref додає до замовлення cart.js (поле aff) - order-submit
      перевіряє підпис і строк і прив'язує замовлення до партнера.
   3. Партнер, який відкривав вкладку «Партнерська програма» в кабінеті /b2b/
      у цьому браузері, бачить на сторінці товару кнопку «Скопіювати моє посилання».

   ⚠ URL і ключ - ті самі, що в assets/js/admin-shell.js. Назва параметра
   ref - та сама, що AFFILIATE_PARAM у scripts/generate_static_pages.js. */
(function () {
  'use strict';

  const API = 'https://uvndubhmqzqqsrnrxgaj.supabase.co/functions/v1/affiliate';
  const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2bmR1YmhtcXpxcXNybnJ4Z2FqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzNDY4MDIsImV4cCI6MjEwMzkyMjgwMn0.AavrYyhDXBQkjKOMdQ9wAQX6B901dOfUpmtUDwO5Cv8';
  const PARAM = 'ref';
  const COOKIE = 'aff_ref';
  const CODE_RE = /^[A-Za-z0-9]{4,12}$/;
  const PARTNER_KEY = 'avtonomka_aff_code'; // пише кабінет /b2b/, коли партнер відкриває свою вкладку

  function readCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function writeCookie(name, value, maxAge) {
    document.cookie = name + '=' + encodeURIComponent(value) + '; Max-Age=' + Math.max(0, Math.floor(maxAge)) +
      '; Path=/; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
  }

  /* Код з адреси: #aff=КОД (після 301) або ?ref=КОД (якщо 301 не було).
     Адресу одразу чистимо, інші параметри (UTM тощо) лишаються. */
  function takeCode() {
    let code = null;
    const hash = location.hash.match(/^#aff=([A-Za-z0-9]{4,12})$/);
    if (hash) code = hash[1];
    const url = new URL(location.href);
    if (url.searchParams.has(PARAM)) {
      const q = url.searchParams.get(PARAM);
      if (!code && CODE_RE.test(q || '')) code = q;
      url.searchParams.delete(PARAM);
    }
    if (hash) url.hash = '';
    if (hash || url.href !== location.href) {
      try { history.replaceState(history.state, '', url.pathname + url.search + url.hash); } catch (e) { /* ignore */ }
    }
    return code;
  }

  function track(code) {
    fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ANON_KEY, apikey: ANON_KEY },
      body: JSON.stringify({ action: 'click', code: code, landing: location.href, referrer: document.referrer || null, token: readCookie(COOKIE) })
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.token && j.max_age > 0) writeCookie(COOKIE, j.token, j.max_age); })
      .catch(function (err) { console.warn('Affiliate: click', err); });
  }

  /* Кнопка партнера на сторінці товару: те саме посилання з ?ref=КОД. */
  function partnerButton() {
    let code = null;
    try { code = localStorage.getItem(PARTNER_KEY); } catch (e) { /* приватне вікно */ }
    if (!code || !/\/product\//.test(location.pathname)) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '🔗 Скопіювати моє посилання';
    btn.title = 'Посилання на цей товар з вашим партнерським кодом ' + code;
    btn.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:900;padding:10px 16px;border:none;border-radius:24px;' +
      'background:#1a2e4a;color:#fff;font:600 14px/1.2 inherit;box-shadow:0 4px 16px rgba(0,0,0,.25);cursor:pointer';
    btn.addEventListener('click', function () {
      const link = location.origin + location.pathname + '?' + PARAM + '=' + encodeURIComponent(code);
      const done = function () { btn.textContent = '✓ Скопійовано'; setTimeout(function () { btn.textContent = '🔗 Скопіювати моє посилання'; }, 2000); };
      if (navigator.clipboard) navigator.clipboard.writeText(link).then(done, function () { prompt('Ваше посилання:', link); });
      else prompt('Ваше посилання:', link);
    });
    document.body.appendChild(btn);
  }

  window.Affiliate = { token: function () { return readCookie(COOKIE); } };

  const code = takeCode();
  if (code) track(code);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', partnerButton);
  else partnerButton();
})();
