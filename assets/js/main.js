/* main.js - загальна логіка */

/* ---- Active nav link ---- */
(function () {
  const path = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.main-nav a').forEach(link => {
    const href = link.getAttribute('href').split('/').pop();
    if (href === path || (path === '' && href === 'index.html')) {
      link.classList.add('active');
      const dropdown = link.closest('.dropdown-menu');
      if (dropdown) {
        const toggle = dropdown.previousElementSibling;
        if (toggle && toggle.classList.contains('dropdown-toggle')) toggle.classList.add('active');
      }
    }
  });
})();

/* ---- Mobile burger ---- */
(function () {
  const burger = document.querySelector('.burger');
  const nav    = document.querySelector('.main-nav');
  if (!burger || !nav) return;

  burger.addEventListener('click', () => {
    const open = burger.classList.toggle('open');
    nav.classList.toggle('open', open);
    burger.setAttribute('aria-expanded', open);
    if (!open) closeAllDropdowns();
  });

  document.addEventListener('click', e => {
    if (!burger.contains(e.target) && !nav.contains(e.target)) {
      burger.classList.remove('open');
      nav.classList.remove('open');
      closeAllDropdowns();
    }
  });
})();

/* ---- Nav dropdown ("Інформація") - hover on desktop (CSS), click/tap here ---- */
function closeAllDropdowns(except) {
  document.querySelectorAll('.main-nav .has-dropdown.open').forEach(el => {
    if (el === except) return;
    el.classList.remove('open');
    const toggle = el.querySelector(':scope > .dropdown-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  });
}

(function () {
  document.querySelectorAll('.main-nav .has-dropdown > .dropdown-toggle').forEach(toggle => {
    toggle.addEventListener('click', e => {
      e.preventDefault();
      const parent = toggle.closest('.has-dropdown');
      const willOpen = !parent.classList.contains('open');
      closeAllDropdowns(willOpen ? parent : null);
      parent.classList.toggle('open', willOpen);
      toggle.setAttribute('aria-expanded', String(willOpen));
    });
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.has-dropdown')) closeAllDropdowns();
  });
})();

/* ---- Format price "11505 UAH" → "11 505 UAH" ---- */
function formatPrice(raw) {
  if (!raw) return '';
  const m = raw.match(/([\d.]+)\s*(.*)/);
  if (!m) return raw;
  const num = parseFloat(m[1]);
  const currency = m[2] || '';
  return num.toLocaleString('uk-UA', { maximumFractionDigits: 0 }) + ' ' + currency;
}

/* ---- Strip HTML tags ---- */
function stripHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || '';
}

/* ---- Truncate string ---- */
function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len).trimEnd() + '…' : str;
}

/* ---- Build Telegram order link ---- */
function tgOrderLink(title) {
  const text = encodeURIComponent('Хочу замовити: ' + title);
  return 'https://telegram.me/avtonomka_od?text=' + text;
}

/* ---- Expose helpers globally ---- */
window.AvtonomkaUtils = { formatPrice, stripHtml, truncate, tgOrderLink };

/* ---- Article view counter (Abacus - free hosted hit counter, shared across
   articles.html and the "Останні статті" block on the homepage so both show
   the same numbers). /get reads without incrementing; /hit increments too -
   only call hit:true for the article actually being opened, never a preview
   card. Best-effort: if the service is unreachable, the element is removed
   rather than showing a broken placeholder. ---- */
(function () {
  const VIEWS_NAMESPACE = 'avtonomka-com-ua-articles';

  function pluralizeUk(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  function viewsLabel(n) {
    if (window.I18n && window.I18n.lang === 'en') return n === 1 ? 'view' : 'views';
    return pluralizeUk(n, 'перегляд', 'перегляди', 'переглядів');
  }

  async function fetchViews(id, hit) {
    const url = `https://abacus.jasoncameron.dev/${hit ? 'hit' : 'get'}/${VIEWS_NAMESPACE}/${encodeURIComponent('article-' + id)}`;
    try {
      const res = await fetch(url);
      if (res.status === 404) return 0;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      return typeof data.value === 'number' ? data.value : null;
    } catch (e) {
      console.warn('Лічильник переглядів недоступний:', e);
      return null;
    }
  }

  function populateViews(scopeEl, hit) {
    scopeEl.querySelectorAll('[data-views-id]').forEach((el) => {
      const id = el.dataset.viewsId;
      fetchViews(id, hit).then((count) => {
        if (count === null) { el.remove(); return; }
        el.textContent = `👁 ${count.toLocaleString('uk-UA')} ${viewsLabel(count)}`;
      });
    });
  }

  window.AvtonomkaViews = { fetchViews, populateViews, viewsLabel };
})();

/* ---- Lightbox (click-to-zoom photo), shared by product.js and category cards ---- */
function openLightbox(src, alt) {
  let overlay = document.getElementById('photo-lightbox');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'photo-lightbox';
    overlay.className = 'photo-lightbox';
    overlay.innerHTML = '<span class="photo-lightbox__close" aria-label="Закрити">&times;</span><div class="photo-lightbox__scroll"><img class="photo-lightbox__img"></div>';
    document.body.appendChild(overlay);
    const scroll = overlay.querySelector('.photo-lightbox__scroll');
    const img = overlay.querySelector('.photo-lightbox__img');

    const closeBox = () => { overlay.classList.remove('is-open'); img.classList.remove('is-zoomed'); };
    overlay.addEventListener('click', closeBox);
    overlay.querySelector('.photo-lightbox__close').addEventListener('click', (e) => { e.stopPropagation(); closeBox(); });
    scroll.addEventListener('click', (e) => e.stopPropagation());

    img.addEventListener('click', (e) => {
      e.stopPropagation();
      if (img.classList.contains('is-zoomed')) {
        img.classList.remove('is-zoomed');
        scroll.scrollLeft = 0;
        scroll.scrollTop = 0;
      } else {
        const rect = img.getBoundingClientRect();
        const relX = (e.clientX - rect.left) / rect.width;
        const relY = (e.clientY - rect.top) / rect.height;
        img.classList.add('is-zoomed');
        requestAnimationFrame(() => {
          scroll.scrollLeft = relX * img.offsetWidth - scroll.clientWidth / 2;
          scroll.scrollTop = relY * img.offsetHeight - scroll.clientHeight / 2;
        });
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeBox();
    });
  }
  const img = overlay.querySelector('.photo-lightbox__img');
  img.classList.remove('is-zoomed');
  img.src = src;
  img.alt = alt || '';
  overlay.classList.add('is-open');
}

/* ---- Category card magnifier buttons (homepage) ---- */
document.querySelectorAll('.cat-card__zoom').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openLightbox(btn.dataset.zoomSrc, btn.dataset.zoomAlt || '');
  });
});

/* ---- Бігучий рядок над шапкою: підписка на Telegram-канал ---- */
const SITE_LANG = (() => {
  try { return new URLSearchParams(location.search).get('lang') || localStorage.getItem('lang') || 'uk'; } catch { return 'uk'; }
})();

(function () {
  const header = document.querySelector('.site-header');
  // Не в Telegram mini app - там людина вже в Telegram.
  if (!header || window.Telegram?.WebApp?.initData) return;
  const text = SITE_LANG === 'en' ? 'Follow us on Telegram' : 'Підписуйтесь на наш Telegram-канал';
  const ticker = document.createElement('a');
  ticker.className = 'tg-ticker';
  ticker.href = 'https://t.me/avtonomka_od';
  ticker.target = '_blank';
  ticker.rel = 'noopener';
  ticker.setAttribute('aria-label', text);
  const track = document.createElement('span');
  track.className = 'tg-ticker__track';
  track.setAttribute('aria-hidden', 'true');
  // Дві однакові половини: анімація зсуває на -50%, і стрічка йде без розриву.
  for (let i = 0; i < 12; i++) {
    const item = document.createElement('span');
    item.className = 'tg-ticker__item';
    item.textContent = text;
    track.append(item);
  }
  ticker.append(track);
  header.before(ticker);
})();

/* ---- Сторінка товару: «зараз переглядають N людей» (1-10) ---- */
(function () {
  const priceBlock = document.querySelector('.product-info__price-block');
  if (!priceBlock) return;
  const id = document.querySelector('[data-add-to-cart]')?.dataset.id
    || new URLSearchParams(location.search).get('id') || location.pathname;
  const key = 'viewers:' + id;
  let n = 0;
  try { n = Number(sessionStorage.getItem(key)) || 0; } catch {}
  if (n < 1 || n > 10) n = 1 + Math.floor(Math.random() * 10);

  const el = document.createElement('div');
  el.className = 'product-viewers';
  priceBlock.after(el);

  function label(count) {
    if (SITE_LANG === 'en') return count === 1 ? '1 person is viewing this product right now' : `${count} people are viewing this product right now`;
    const word = count === 1 ? 'людина' : count < 5 ? 'людини' : 'людей';
    return `Зараз цей товар переглядають ${count} ${word}`;
  }
  function show() {
    el.innerHTML = '<span class="product-viewers__dot"></span>';
    el.append(label(n));
    try { sessionStorage.setItem(key, String(n)); } catch {}
  }
  show();
  // Час від часу число трохи змінюється (±1, в межах 1-10).
  (function tick() {
    setTimeout(() => {
      n = Math.min(10, Math.max(1, n + (Math.random() < 0.5 ? -1 : 1)));
      show();
      tick();
    }, 15000 + Math.random() * 25000);
  })();
})();

/* ---- Пошук товарів у шапці ----
   Поле вставляється в .header-actions на всіх сторінках. products.json
   вантажиться лише при першому фокусі; Enter / «Усі результати» ведуть
   на catalog.html?q=… (catalog.js підхоплює параметр). */
const SITE_ROOT = (document.currentScript && document.currentScript.src || '')
  .replace(/assets\/js\/main\.js.*$/, '');

window.SiteSearch = (function () {
  const compact = (s) => s.replace(/[\s\-–._/,()]+/g, '');
  function haystack(p) {
    const title = window.I18n ? window.I18n.productTitle(p) : '';
    const text = [title, p.title, p.mpn, p.id].filter(Boolean).join(' ').toLowerCase();
    return { text, compact: compact(text) };
  }
  // Кожне слово запиту має знайтися (порядок не важливий);
  // «lp16-24200» і «lp16 24200» знаходять одне й те саме.
  function matches(p, query) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const h = haystack(p);
    return words.every(w => h.text.includes(w) || h.compact.includes(compact(w)));
  }
  return { matches };
})();

(function () {
  const actions = document.querySelector('.site-header .header-actions');
  if (!actions || window.Telegram?.WebApp?.initData) return;

  const en = SITE_LANG === 'en';
  const L = {
    placeholder: en ? 'Search products…' : 'Пошук товарів…',
    open: en ? 'Search' : 'Пошук',
    empty: en ? 'Nothing found' : 'Нічого не знайдено',
    toCatalog: en ? 'Go to catalog' : 'Перейти до каталогу',
    all: en ? 'All results' : 'Усі результати',
    inStock: en ? 'In stock' : 'В наявності',
    outStock: en ? 'Out of stock' : 'Немає в наявності',
  };
  const MAX = 7;
  const catalogUrl = SITE_ROOT + 'catalog.html';
  const icon = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'header-search-toggle';
  toggle.setAttribute('aria-label', L.open);
  toggle.setAttribute('aria-expanded', 'false');
  toggle.innerHTML = icon;

  const form = document.createElement('form');
  form.className = 'header-search';
  form.role = 'search';
  form.action = catalogUrl;
  form.innerHTML =
    '<span class="header-search__icon">' + icon + '</span>' +
    '<input type="search" name="q" class="header-search__input" autocomplete="off" ' +
      'role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="header-search-list">' +
    '<div class="header-search__results" id="header-search-list" role="listbox" hidden></div>';
  const input = form.querySelector('input');
  const list = form.querySelector('.header-search__results');
  input.placeholder = L.placeholder;
  input.setAttribute('aria-label', L.placeholder);

  actions.prepend(form);
  actions.prepend(toggle);
  const header = actions.closest('.site-header');

  let products = null;
  let loading = null;
  let active = -1;

  function load() {
    if (!loading) {
      loading = fetch(SITE_ROOT + 'products.json')
        .then(r => r.ok ? r.json() : [])
        .then(d => { products = Array.isArray(d) ? d : (d.products || []); })
        .catch(() => { products = []; });
    }
    return loading;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function price(raw) {
    const num = parseFloat(raw);
    if (isNaN(num)) return raw || '';
    const currency = raw.replace(/[\d.\s]+/, '').trim() || 'UAH';
    return num.toLocaleString('uk-UA', { maximumFractionDigits: 0 }) + ' ' + currency;
  }
  function productUrl(p) {
    return SITE_ROOT + 'product/' + encodeURIComponent(p.slug || p.id) + '/' + encodeURIComponent(p.id) + '.html';
  }
  function resultsUrl(q) {
    return catalogUrl + '?q=' + encodeURIComponent(q);
  }

  function setOpen(open) {
    list.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    if (!open) { active = -1; input.removeAttribute('aria-activedescendant'); }
  }

  function render() {
    const q = input.value.trim();
    if (q.length < 2 || !products) { setOpen(false); return; }
    const found = products.filter(p => window.SiteSearch.matches(p, q));
    // Спершу те, що в наявності.
    found.sort((a, b) => (b.availability === 'in_stock') - (a.availability === 'in_stock'));
    active = -1;
    if (!found.length) {
      list.innerHTML = '<div class="header-search__empty">' + L.empty +
        ' · <a href="' + catalogUrl + '">' + L.toCatalog + '</a></div>';
    } else {
      list.innerHTML = found.slice(0, MAX).map((p, i) => {
        const title = window.I18n ? window.I18n.productTitle(p) : p.title;
        const inStock = p.availability === 'in_stock';
        return '<a class="header-search__item" role="option" id="hs-opt-' + i + '" href="' + productUrl(p) + '">' +
          '<img src="' + esc(/^https?:/.test(p.image_link || '') ? p.image_link : SITE_ROOT + (p.image_link || '')) + '" alt="" loading="lazy">' +
          '<span class="header-search__info">' +
            '<span class="header-search__title">' + esc(title) + '</span>' +
            '<span class="header-search__meta"><b>' + esc(price(p.price)) + '</b>' +
            '<span class="' + (inStock ? 'is-in' : 'is-out') + '">' + (inStock ? L.inStock : L.outStock) + '</span></span>' +
          '</span></a>';
      }).join('') +
        '<a class="header-search__all" href="' + resultsUrl(q) + '">' + L.all + ' (' + found.length + ') →</a>';
    }
    setOpen(true);
  }

  function highlight(i) {
    const items = list.querySelectorAll('.header-search__item');
    if (!items.length) return;
    active = (i + items.length) % items.length;
    items.forEach((el, n) => el.classList.toggle('is-active', n === active));
    input.setAttribute('aria-activedescendant', items[active].id);
    items[active].scrollIntoView({ block: 'nearest' });
  }

  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => load().then(render), 150);
  });
  input.addEventListener('focus', () => { load().then(() => { if (input.value.trim()) render(); }); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active - 1); }
    else if (e.key === 'Escape') {
      if (!list.hidden) setOpen(false);
      else closePanel();
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const item = active >= 0 && list.querySelectorAll('.header-search__item')[active];
    if (item) { location.href = item.href; return; }
    const q = input.value.trim();
    if (q) location.href = resultsUrl(q);
  });

  // Вузькі екрани: іконка розгортає поле панеллю під шапкою.
  function closePanel() {
    header.classList.remove('search-open');
    toggle.setAttribute('aria-expanded', 'false');
    setOpen(false);
  }
  toggle.addEventListener('click', () => {
    const open = header.classList.toggle('search-open');
    toggle.setAttribute('aria-expanded', String(open));
    // Мобільне меню й панель пошуку відкриваються в одному місці.
    const burger = document.querySelector('.burger.open');
    if (open && burger) burger.click();
    if (open) input.focus();
    else setOpen(false);
  });
  document.addEventListener('click', (e) => {
    if (form.contains(e.target) || toggle.contains(e.target)) return;
    setOpen(false);
  });
})();
