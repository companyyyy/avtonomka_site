/* articles.js - public articles page */

/* Статті живуть у Supabase (таблиця public.articles), не в
   data/articles.json - читання публічне (RLS: anon can read articles),
   тому досить простого fetch з anon-ключем, без клієнтської бібліотеки.
   ⚠ Ці значення мають збігатися з admin.html і index.html. */
const ARTICLES_SUPABASE_URL = 'https://uvndubhmqzqqsrnrxgaj.supabase.co';
const ARTICLES_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2bmR1YmhtcXpxcXNybnJ4Z2FqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzNDY4MDIsImV4cCI6MjEwMzkyMjgwMn0.AavrYyhDXBQkjKOMdQ9wAQX6B901dOfUpmtUDwO5Cv8';

async function fetchArticles() {
  const resp = await fetch(`${ARTICLES_SUPABASE_URL}/rest/v1/articles?select=*`, {
    headers: {
      apikey: ARTICLES_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${ARTICLES_SUPABASE_ANON_KEY}`,
    },
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return resp.json();
}

/* Same slug <-> category mapping as catalog.js / product.js / generate_static_pages.js.
   Kept as its own copy here since this page doesn't load catalog.js. */
const SLUG_TO_CATEGORY = {
  'hybridni-invertory':   'Автономна енергетика > Гибридні інвертори',
  'akumulyatory':         'Автономна енергетика > Акумулятори для гібридних інверторів',
  'komplekty':            'Автономна енергетика > Комплекти автономного енергоживлення',
  'kabeli':               'Автономна енергетика > Силові та сонячні кабелі',
  'dzherela-zhyvlennya':  'Обладнання > Джерела безперебійного живлення',
  'akumulyatory-dbzh':    'Акумулятори і батарейки > Акумулятори для ДБЖ',
  'systemy-zberihannya':  'Автономна енергетика > Системи зберігання електроенергії 2 в 1',
};

function articleField(article, field) {
  if (window.I18n && window.I18n.lang === 'en') {
    var enVal = article[field + '_en'];
    if (enVal) return enVal;
  }
  return article[field] || '';
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* Minimal inline markdown support for article body paragraphs: **bold** and
   [text](https://...) links. Operates on already-escHtml'd text, so the
   only tags it can introduce are the whitelisted <strong>/<a> below - no
   other HTML can reach the page through article content. Link targets are
   restricted to http(s) URLs (no javascript:, no bare "#"). */
function formatInline(escapedText) {
  return escapedText
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const locale = window.I18n ? window.I18n.dateLocale : 'uk-UA';
  return new Date(dateStr).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
}

function t(key) {
  return window.I18n ? window.I18n.t(key) : key;
}

/* ---- View counter (Abacus - free hosted hit counter, no backend of our own) ----
   /get reads without incrementing (article list cards); /hit increments and
   reads (opening the full article). Best-effort: if the service is down or
   blocked, the views element is just removed rather than showing a broken "…". */
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
    /* /get on a key nobody has ever opened yet (so no /hit was ever made
       for it) 404s with {"error":"Key not found"} - that's just 0 views,
       not a real failure. */
    if (res.status === 404) return 0;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return typeof data.value === 'number' ? data.value : null;
  } catch (e) {
    console.warn('Лічильник переглядів недоступний:', e);
    return null;
  }
}

/* Fills every [data-views-id] under scopeEl. hit=true also increments the count
   (only for the article actually being opened, never for list cards). */
function populateViews(scopeEl, hit) {
  scopeEl.querySelectorAll('[data-views-id]').forEach(el => {
    const id = el.dataset.viewsId;
    fetchViews(id, hit).then(count => {
      if (count === null) { el.remove(); return; }
      el.textContent = `👁 ${count.toLocaleString('uk-UA')} ${viewsLabel(count)}`;
    });
  });
}

function renderCard(article) {
  const dateStr = formatDate(article.date);
  const title   = articleField(article, 'title');
  const summary = articleField(article, 'summary');
  const imgHtml = article.photo
    ? `<div class="article-card__img"><img src="${escHtml(article.photo)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
    : '<div class="article-card__img article-card__img--placeholder"></div>';
  const metaParts = [];
  if (dateStr) metaParts.push(escHtml(dateStr));
  metaParts.push(`<span class="article-card__views" data-views-id="${escHtml(article.id)}">…</span>`);
  return `
  <article class="article-card" data-id="${escHtml(article.id)}" tabindex="0" role="button" aria-label="${escHtml(title)}">
    ${imgHtml}
    <div class="article-card__body">
      <div class="article-card__date">${metaParts.join(' · ')}</div>
      <h2 class="article-card__title">${escHtml(title)}</h2>
      ${summary ? `<p class="article-card__summary">${escHtml(summary)}</p>` : ''}
    </div>
    <div class="article-card__footer">
      <span class="article-card__link">${t('articles.read_more')}</span>
    </div>
  </article>`;
}

/* Up to 4 in-stock-first products whose product_type matches the article's
   category slug. Returns [] if the article has no category or nothing matches
   - the caller then renders no block at all, rather than an empty one. */
function relatedProducts(article) {
  if (!article.category) return [];
  const productType = SLUG_TO_CATEGORY[article.category];
  if (!productType) return [];
  return allProducts
    .filter(p => p.product_type === productType)
    .slice(0, 4);
}

function renderRelatedProductCard(p) {
  const priceStr = formatPrice(p.price || '');
  const title    = p.title || '';
  const img      = p.image_link || 'assets/images/zaglushka.png';
  const href     = `product/${encodeURIComponent(p.slug || p.id)}/${encodeURIComponent(p.id)}.html`;

  return `
  <div class="product-card">
    <a href="${href}" class="product-card__img-wrap" aria-label="${escHtml(title)}">
      <img src="${escHtml(img)}" alt="${escHtml(title)}" loading="lazy" onerror="this.src='assets/images/zaglushka.png'">
    </a>
    <div class="product-card__body">
      <a href="${href}" class="product-card__title">${escHtml(title)}</a>
      <div class="product-card__price-row">
        <span class="product-card__price">${escHtml(priceStr)}</span>
      </div>
    </div>
  </div>`;
}

function renderRelatedProducts(article) {
  const products = relatedProducts(article);
  if (products.length === 0) return '';
  return `
    <div class="article-full__related">
      <h2>${t('articles.related_products_title')}</h2>
      <div class="products-grid products-grid--compact">
        ${products.map(renderRelatedProductCard).join('')}
      </div>
    </div>`;
}

function formatPrice(raw) {
  if (!raw) return '';
  const num = parseFloat(raw);
  if (isNaN(num)) return raw;
  const currency = raw.replace(/[\d.\s]+/, '').trim() || 'UAH';
  return num.toLocaleString('uk-UA', { maximumFractionDigits: 0 }) + ' ' + currency;
}

function renderFull(article) {
  const dateStr = formatDate(article.date);
  const title   = articleField(article, 'title');
  const summary = articleField(article, 'summary');
  const body    = articleField(article, 'body');
  const imgHtml = article.photo
    ? `<div class="article-full__img"><img src="${escHtml(article.photo)}" alt="${escHtml(title)}" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
    : '';
  const metaParts = [];
  if (dateStr) metaParts.push(escHtml(dateStr));
  metaParts.push(`<span class="article-full__views" data-views-id="${escHtml(article.id)}">…</span>`);
  const bodyHtml = body
    .split(/\n\n+/)
    .map(para => para.trim())
    .filter(Boolean)
    .map(para => {
      if (para.startsWith('## ')) {
        return `<h2>${formatInline(escHtml(para.slice(3).trim()))}</h2>`;
      }
      const lines = para.split('\n');
      if (lines.length > 1 && lines.every(line => line.startsWith('- '))) {
        const items = lines.map(line => `<li>${formatInline(escHtml(line.slice(2).trim()))}</li>`).join('');
        return `<ul>${items}</ul>`;
      }
      return `<p>${formatInline(escHtml(para)).replace(/\n/g, '<br>')}</p>`;
    })
    .join('');

  return `
  <div class="article-full">
    <button class="article-full__back" id="btn-back">${t('articles.back')}</button>
    ${imgHtml}
    <div class="article-full__content">
      <div class="article-full__date">${metaParts.join(' · ')}</div>
      <h1 class="article-full__title">${escHtml(title)}</h1>
      ${summary ? `<p class="article-full__lead">${escHtml(summary)}</p>` : ''}
      <div class="article-full__body">${bodyHtml}</div>
      ${renderRelatedProducts(article)}
    </div>
  </div>`;
}

let allArticles = [];
let allProducts = [];

function openArticle(id) {
  const article = allArticles.find(a => a.id === id);
  if (!article) return;

  const detailEl = document.getElementById('article-detail');
  const listEl   = document.getElementById('articles-list');

  detailEl.innerHTML = renderFull(article);
  populateViews(detailEl, true);
  document.getElementById('btn-back').addEventListener('click', closeArticle);

  listEl.classList.add('hidden');
  detailEl.classList.remove('hidden');

  history.pushState({ articleId: id }, '', '#' + id);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function closeArticle() {
  const detailEl = document.getElementById('article-detail');
  const listEl   = document.getElementById('articles-list');

  detailEl.classList.add('hidden');
  listEl.classList.remove('hidden');

  history.pushState('', document.title, window.location.pathname);
  window.scrollTo({ top: 0 });
}

window.addEventListener('popstate', () => {
  const hash = window.location.hash.slice(1);
  if (hash && allArticles.find(a => a.id === hash)) {
    openArticle(hash);
  } else {
    const detailEl = document.getElementById('article-detail');
    const listEl   = document.getElementById('articles-list');
    if (detailEl && listEl) {
      detailEl.classList.add('hidden');
      listEl.classList.remove('hidden');
    }
  }
});

async function init() {
  const grid = document.getElementById('articles-grid');
  if (!grid) return;

  grid.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>${t('articles.loading')}</span></div>`;

  try {
    allArticles = await fetchArticles();
    if (Array.isArray(allArticles)) {
      allArticles.sort((a, b) => new Date(b.date) - new Date(a.date));
    }

    /* Products for the "Схожі товари" block - best-effort: if this fails,
       articles still render, just without related-product suggestions. */
    try {
      const prodResp = await fetch('products.json');
      if (prodResp.ok) allProducts = await prodResp.json();
    } catch (e) {
      console.warn('articles.js: could not load products.json for related products', e);
    }

    if (!Array.isArray(allArticles) || allArticles.length === 0) {
      grid.innerHTML = `
        <div class="empty-state">
          <img src="assets/images/sticker.webp" alt="" loading="lazy">
          <h3>${t('articles.empty_title')}</h3>
          <p>${t('articles.empty_text')}</p>
        </div>`;
      return;
    }

    grid.innerHTML = allArticles.map(renderCard).join('');
    populateViews(grid, false);

    grid.addEventListener('click', e => {
      const card = e.target.closest('.article-card');
      if (card) openArticle(card.dataset.id);
    });
    grid.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        const card = e.target.closest('.article-card');
        if (card) openArticle(card.dataset.id);
      }
    });

    const hash = window.location.hash.slice(1);
    if (hash && allArticles.find(a => a.id === hash)) openArticle(hash);

  } catch (e) {
    grid.innerHTML = `
      <div class="empty-state">
        <img src="assets/images/sticker.webp" alt="" loading="lazy">
        <h3>${t('articles.error_title')}</h3>
        <p>${t('articles.error_text')}</p>
      </div>`;
    console.error(e);
  }
}

/* ---- Start: wait for i18n ---- */
if (window.I18n) {
  init();
} else {
  document.addEventListener('i18n:ready', init);
}
