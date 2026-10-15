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
  const text = SITE_LANG === 'en'
    ? '📢 Subscribe to our Telegram channel - news, deals and new arrivals'
    : '📢 Підписуйтесь на наш Telegram-канал - новини, акції та нові надходження';
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
  for (let i = 0; i < 8; i++) {
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
