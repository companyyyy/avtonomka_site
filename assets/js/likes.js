/* likes.js - сердечка «Подобається» на товарах сайту, без реєстрації.
   Кнопка з лічильником з'являється на кожній картці товару (.product-card -
   каталог, «схожі товари» у статтях) і на сторінці товару біля ціни. Число
   спільне для всіх відвідувачів: лайки на сайті + лайки в Telegram-мініаппі.

   Відвідувач - випадковий id у localStorage (один лайк на товар від
   браузера); що він лайкнув, теж пам'ятає localStorage. Дані й захист від
   накрутки - scripts/supabase/site_likes_schema.sql.
   ⚠ SUPABASE_URL / ключ - ті самі, що в assets/js/comments.js. */
(function () {
  const SUPABASE_URL = 'https://uvndubhmqzqqsrnrxgaj.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2bmR1YmhtcXpxcXNybnJ4Z2FqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzNDY4MDIsImV4cCI6MjEwMzkyMjgwMn0.AavrYyhDXBQkjKOMdQ9wAQX6B901dOfUpmtUDwO5Cv8';
  const LIKED_KEY = 'avtonomka_site_likes';
  const VISITOR_KEY = 'avtonomka_visitor_id';

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) { return null; }
  }

  function visitorId() {
    let id = store(VISITOR_KEY);
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) ||
        'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
      store(VISITOR_KEY, id);
    }
    return id;
  }

  let liked = new Set();
  try { liked = new Set(JSON.parse(store(LIKED_KEY) || '[]')); } catch (e) {}
  const saveLiked = () => store(LIKED_KEY, JSON.stringify([...liked]));
  const counts = new Map();

  function rpc(fn, args) {
    return fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {}),
    }).then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))));
  }

  const style = document.createElement('style');
  style.textContent = `
    .product-card { position: relative; }
    .like-heart { display: inline-flex; align-items: center; gap: 5px; border: none; cursor: pointer;
      font-family: inherit; font-size: .85rem; font-weight: 600; line-height: 1; color: #6c757d; background: rgba(255,255,255,.92);
      border-radius: 999px; padding: 6px 10px; box-shadow: 0 1px 4px rgba(26,46,74,.18);
      transition: transform .12s, color .15s; }
    .like-heart svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; flex-shrink: 0; }
    .like-heart:hover { color: #e53935; }
    .like-heart:active { transform: scale(.94); }
    .like-heart.is-liked { color: #e53935; }
    .like-heart.is-liked svg { fill: currentColor; }
    .like-heart__count:empty { display: none; }
    .product-card > .like-heart { position: absolute; top: 10px; right: 10px; z-index: 2; }
    .like-heart--page { margin-top: 10px; background: #fff; border: 1px solid #e0e6ed; box-shadow: none; padding: 7px 14px; }
    .like-heart--page .like-heart__label { color: #6c757d; font-weight: 500; }`;
  document.head.append(style);

  const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.3C.9 8.2 3 4.5 6.6 4.5c2.1 0 3.6 1.2 4.4 2.6.8-1.4 2.3-2.6 4.4-2.6 3.6 0 5.7 3.7 4.2 7.2C19.5 16.4 12 21 12 21z"/></svg>';

  // id товару з посилання .../product/<slug>/<id>.html (або product.html?id=...)
  function idFromUrl(url) {
    const m = /\/product\/(?:[^/]+\/)?([A-Za-z0-9]+)\.html(?:[?#]|$)/.exec(url);
    if (m) return m[1];
    try { return new URL(url, location.href).searchParams.get('id'); } catch (e) { return null; }
  }

  function makeButton(id, page) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'like-heart' + (page ? ' like-heart--page' : '');
    b.dataset.likeProduct = id;
    b.innerHTML = HEART + '<span class="like-heart__count"></span>' + (page ? '<span class="like-heart__label">подобається</span>' : '');
    paint(b);
    return b;
  }

  function paint(b) {
    const id = b.dataset.likeProduct;
    const on = liked.has(id);
    const n = counts.get(id) || 0;
    b.classList.toggle('is-liked', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.title = on ? 'Вам подобається' : 'Подобається';
    b.setAttribute('aria-label', (on ? 'Прибрати «подобається»' : 'Подобається') + (n ? ` (${n})` : ''));
    b.querySelector('.like-heart__count').textContent = n ? String(n) : '';
  }
  const repaint = id => document.querySelectorAll(`[data-like-product="${CSS.escape(id)}"]`).forEach(paint);

  function decorate() {
    document.querySelectorAll('.product-card:not([data-like-ready])').forEach(card => {
      card.dataset.likeReady = '1';
      const link = card.querySelector('a[href*="product"]');
      const id = link && idFromUrl(link.getAttribute('href'));
      if (id) card.append(makeButton(id, false));
    });
    // Сторінка товару: кнопка під ціною
    const priceBlock = document.querySelector('.product-info__price-block');
    if (priceBlock && !priceBlock.querySelector('.like-heart')) {
      const id = idFromUrl(location.href);
      if (id) priceBlock.append(makeButton(id, true));
    }
  }

  document.addEventListener('click', e => {
    const b = e.target.closest('.like-heart');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    const id = b.dataset.likeProduct;
    const want = !liked.has(id);
    // Одразу показуємо результат, потім звіряємо з сервером
    if (want) liked.add(id); else liked.delete(id);
    counts.set(id, Math.max(0, (counts.get(id) || 0) + (want ? 1 : -1)));
    saveLiked(); repaint(id);
    rpc('site_set_like', { p_product_id: id, p_visitor_id: visitorId(), p_liked: want })
      .then(res => {
        if (res.liked) liked.add(id); else liked.delete(id);
        counts.set(id, Number(res.likes) || 0);
        saveLiked(); repaint(id);
      })
      .catch(() => {
        if (want) liked.delete(id); else liked.add(id);
        counts.set(id, Math.max(0, (counts.get(id) || 0) + (want ? -1 : 1)));
        saveLiked(); repaint(id);
      });
  }, true);

  // Картки каталогу перемальовуються при фільтрах, сторінка товару
  // заповнюється скриптом - стежимо за змінами DOM.
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; decorate(); });
  }).observe(document.body, { childList: true, subtree: true });

  decorate();
  rpc('product_like_counts')
    .then(rows => {
      rows.forEach(r => counts.set(String(r.product_id), Number(r.likes) || 0));
      document.querySelectorAll('[data-like-product]').forEach(paint);
    })
    .catch(() => {});
})();
