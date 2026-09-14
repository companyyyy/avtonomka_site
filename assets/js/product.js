/* product.js - сторінка окремого товару (self-contained) */
/* openLightbox() is defined in main.js (shared across pages) */

/* ---- Local helpers ---- */
function cleanDescription(html) {
  if (!html) return '';
  return html
    .replace(/lt;\/[a-z][a-z0-9]*/gi, '')
    .replace(/lt;[a-z][^>]*>/gi, '')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&mdash;/g, '-')
    .replace(/&ndash;/g, '–')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* Strip HTML tables (for EN description) */
function stripTables(html) {
  if (!html) return html;
  return html.replace(/<table[\s\S]*?<\/table>/gi, '');
}

function formatPrice(raw) {
  if (!raw) return '';
  const num = parseFloat(raw);
  if (isNaN(num)) return raw;
  const currency = raw.replace(/[\d.\s]+/, '').trim() || 'UAH';
  return num.toLocaleString('uk-UA', { maximumFractionDigits: 0 }) + ' ' + currency;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function t(key) {
  return window.I18n ? window.I18n.t(key) : key;
}

const _SLUG_TO_CATEGORY = {
  'hybridni-invertory':   'Автономна енергетика > Гибридні інвертори',
  'akumulyatory':         'Автономна енергетика > Акумулятори для гібридних інверторів',
  'komplekty':            'Автономна енергетика > Комплекти автономного енергоживлення',
  'kabeli':               'Автономна енергетика > Силові та сонячні кабелі',
  'dzherela-zhyvlennya':  'Обладнання > Джерела безперебійного живлення',
};
const _CATEGORY_TO_SLUG = {};
Object.keys(_SLUG_TO_CATEGORY).forEach(function(slug) {
  _CATEGORY_TO_SLUG[_SLUG_TO_CATEGORY[slug]] = slug;
});

function categoryLabel(productType) {
  if (!productType) return '';
  var slug = _CATEGORY_TO_SLUG[productType];
  if (slug && window.I18n) {
    var label = window.I18n.t('categories.' + slug);
    if (label && label !== 'categories.' + slug) return label;
  }
  return productType.split('>').pop().trim();
}

/* ---- Badge helpers (mirrors assets/js/catalog.js - same badges the
   catalog card shows for this product, kept in sync by hand). ---- */
const KNOWN_BRANDS = ['DAH Solar', 'Deye', 'Dyness', 'Felicity', 'Must'];
function extractBrand(title) {
  if (!title) return null;
  for (const b of KNOWN_BRANDS) {
    const re = new RegExp('\\b' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (re.test(title)) return b;
  }
  return null;
}
function kitBrandParts(title) {
  const body = (title || '').replace(/^Комплект автономного енергоживлення:\s*/i, '');
  const parts = body.split(/\s*\+\s*/);
  if (parts.length !== 2) return [null, null];
  return [extractBrand(parts[0]), extractBrand(parts[1])];
}
/* Inverter/battery model text for the "Даташит для інвертора/акумулятора: <модель>"
   labels below - same title split as kitBrandParts, just returns the raw text
   (trimmed of trailing comma) instead of just the brand. */
function kitModelParts(title) {
  const body = (title || '').replace(/^Комплект автономного енергоживлення:\s*/i, '');
  const parts = body.split(/\s*\+\s*/).map(s => s.trim().replace(/,\s*$/, ''));
  if (parts.length !== 2) return [null, null];
  return parts;
}
function extractKw(title) {
  if (!title) return null;
  let m = title.match(/(\d+(?:[.,]\d+)?)\s*(?:кВт|kw)(?!h)/i);
  if (m) return m[1].replace(',', '.');
  m = title.match(/(\d+)\s*Вт\b/);
  if (m) return String(Number(m[1]) / 1000);
  m = title.match(/SUN-(\d+)K-/i);
  if (m) return m[1];
  m = title.match(/PV\d+-(\d{2})\d{2}/i);
  if (m) return String(Number(m[1]) / 10);
  return null;
}
function extractKitBatteryKwh(title) {
  const body = (title || '').replace(/^Комплект автономного енергоживлення:\s*/i, '');
  const parts = body.split(/\s*\+\s*/);
  if (parts.length !== 2) return null;
  const battery = parts[1];
  let m = battery.match(/(\d+(?:[.,]\d+)?)\s*kWh/i);
  if (m) return parseFloat(m[1].replace(',', '.'));
  const v = battery.match(/(\d+(?:[.,]\d+)?)\s*V\b/i);
  const ah = battery.match(/(\d+(?:[.,]\d+)?)\s*[AaАа][hH]\b/);
  if (v && ah) return Math.round(parseFloat(v[1].replace(',', '.')) * parseFloat(ah[1].replace(',', '.')) / 10) / 100;
  return null;
}
function kitStatusTier(title) {
  const kwh = extractKitBatteryKwh(title);
  if (kwh === null) return null;
  if (kwh <= 5) return 'light';
  if (kwh <= 12) return 'optimal';
  return 'super';
}
const NOT_LETTER = '(?![а-яіїєА-ЯІЇЄa-zA-Z])';
function extractLength(title) {
  if (!title) return null;
  let m = title.match(new RegExp('(\\d+(?:[.,]\\d+)?)\\s*м' + NOT_LETTER, 'i'));
  if (m) return m[1].replace(',', '.') + ' м';
  m = title.match(new RegExp('(\\d+(?:[.,]\\d+)?)\\s*см' + NOT_LETTER, 'i'));
  if (m) return m[1].replace(',', '.') + ' см';
  m = title.match(new RegExp('(\\d+(?:[.,]\\d+)?)\\s*мм' + NOT_LETTER, 'i'));
  if (m) return m[1].replace(',', '.') + ' мм';
  return null;
}
const AWG_TO_MM2 = { '4': '21' };
function extractCrossSection(title) {
  if (!title) return null;
  let m = title.match(/(\d+)\s*AWG/i);
  if (m) {
    const mm2 = AWG_TO_MM2[m[1]];
    return mm2 ? mm2 + ' мм²' : m[1] + ' AWG';
  }
  m = title.match(/(\d+(?:[.,]\d+)?)\s*мм(?!\d)/i);
  if (m) return m[1].replace(',', '.') + ' мм';
  return null;
}
function extractLugSize(title) {
  if (!title) return null;
  const m = title.match(/накінечники\s*(М\d+)/i);
  return m ? m[1].toUpperCase() : null;
}

/* Mirrors isTopProduct() in catalog.js - same deterministic hash, so the
   same items show TOP here as on the catalog card. */
function isTopProduct(id) {
  let hash = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return hash % 4 === 0;
}

/* Builds the same .product-card__badge-stack markup the catalog card shows
   for this product, so the gallery image gets the same badges. */
function buildBadgeStackHtml(p, displayTitle) {
  const inStock = p.availability === 'in_stock';
  const slug = _CATEGORY_TO_SLUG[p.product_type];
  let extraHtml = '';

  if (slug === 'komplekty') {
    const [invBrand, batBrand] = kitBrandParts(displayTitle);
    let monobrandHtml = '';
    if (invBrand && invBrand === batBrand) {
      monobrandHtml = `<span class="product-card__pill product-card__pill--monobrand">${escHtml(t('catalog.monobrand_badge'))} ${escHtml(invBrand)}</span>`;
    }
    const tier = kitStatusTier(displayTitle);
    const tierHtml = tier
      ? `<span class="product-card__pill product-card__pill--tier-${tier}">${escHtml(t('catalog.tier_' + tier))}</span>`
      : '';
    extraHtml = `<span class="product-card__pill product-card__pill--installment">${escHtml(t('catalog.installment_badge'))}</span>${tierHtml}${monobrandHtml}`;
  } else if (slug === 'kabeli') {
    const cs = extractCrossSection(displayTitle);
    if (cs) extraHtml += `<span class="product-card__pill product-card__pill--spec">⌀ ${escHtml(cs)}</span>`;
    const ls = extractLugSize(displayTitle);
    if (ls) extraHtml += `<span class="product-card__pill product-card__pill--spec">🔩 ${escHtml(ls)}</span>`;
    const len = extractLength(displayTitle);
    if (len) extraHtml += `<span class="product-card__pill product-card__pill--spec">📏 ${escHtml(len)}</span>`;
  }

  const availabilityHtml = slug === 'komplekty' ? '' : `<span class="product-card__pill product-card__pill--${inStock ? 'in-stock' : 'out-of-stock'}">${escHtml(inStock ? t('catalog.in_stock') : t('catalog.out_of_stock'))}</span>`;
  const topBadgeHtml = isTopProduct(p.id) ? `<span class="product-card__pill product-card__pill--top">${escHtml(t('catalog.top_badge'))}</span>` : '';
  return `<div class="product-card__badge-stack">${topBadgeHtml}${availabilityHtml}${extraHtml}</div>`;
}

/* ---- Base path: root product.html vs. /product/<slug>/<id>.html (2 levels deep) ---- */
function getBase() {
  const path = window.location.pathname;
  const depth = path.split('/').length - 2;
  return depth >= 1 && path.includes('/product/') ? '../'.repeat(depth) : '';
}
const BASE = getBase();

/* ---- Віртуальні товари (public.virtual_products, розділ 9.4
   ARCHITECTURE.md) - потрібні тут так само, як на каталозі: без цього
   виклику продукт з id="V..." не знайдеться в products.json і
   showNotFound() затре пре-рендерений HTML сторінки. ⚠ Ці значення мають
   збігатися з assets/js/catalog.js / articles.js / admin.html /
   scripts/generate_static_pages.js. ---- */
const VIRTUAL_SUPABASE_URL = 'https://uvndubhmqzqqsrnrxgaj.supabase.co';
const VIRTUAL_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2bmR1YmhtcXpxcXNybnJ4Z2FqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzNDY4MDIsImV4cCI6MjEwMzkyMjgwMn0.AavrYyhDXBQkjKOMdQ9wAQX6B901dOfUpmtUDwO5Cv8';

function fetchVirtualProducts() {
  return fetch(`${VIRTUAL_SUPABASE_URL}/rest/v1/virtual_products?select=*`, {
    headers: { apikey: VIRTUAL_SUPABASE_ANON_KEY, Authorization: `Bearer ${VIRTUAL_SUPABASE_ANON_KEY}` },
  })
    .then(resp => resp.ok ? resp.json() : [])
    .then(rows => (Array.isArray(rows) ? rows : []).map(r => ({
      id: r.id,
      title: r.title,
      image_link: r.image,
      additional_images: [],
      price: r.price != null ? `${r.price} UAH` : '',
      availability: 'in_stock',
      product_type: r.product_type,
      mpn: r.source_model,
      condition: 'new',
      description: r.description,
      slug: r.slug,
    })))
    .catch(e => { console.warn('product.js: could not load virtual_products:', e); return []; });
}

/* ---- Product id: ?id= (legacy), /product/<id>.html (old stub) or
   /product/<slug>/<id>.html (static pages) — id is always the last segment ---- */
function getProductId() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('id')) return params.get('id');
  const m = window.location.pathname.match(/\/product\/(?:[^/]+\/)?([^/]+)\.html$/);
  return m ? m[1] : null;
}

/* ---- Legacy ?id= link → canonical /product/<id>.html (avoids duplicate content) ---- */
function redirectLegacyIfNeeded() {
  const legacyId = new URLSearchParams(window.location.search).get('id');
  if (!legacyId || window.location.pathname.includes('/product/')) return false;

  const target = BASE + 'product/' + encodeURIComponent(legacyId) + '.html';
  const absoluteTarget = window.location.origin + '/product/' + encodeURIComponent(legacyId) + '.html';

  let link = document.querySelector('link[rel="canonical"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'canonical';
    document.head.appendChild(link);
  }
  link.href = absoluteTarget;

  window.location.replace(target);
  return true;
}

/* ---- Init ---- */
function init() {
  if (redirectLegacyIfNeeded()) return;

  const id = getProductId();
  if (!id) { showNotFound(); return; }

  Promise.all([
    fetch(BASE + 'products.json').then(function(resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    }),
    fetchVirtualProducts(),
  ])
    .then(function(results) {
      const data = results[0];
      const virtual = results[1];
      const products = (Array.isArray(data) ? data : (data.products || [])).concat(virtual);
      const product  = products.find(p => String(p.id) === String(id));
      if (!product) { showNotFound(); return; }
      render(product);
    })
    .catch(function(e) {
      showError();
      console.error('product.js:', e);
    });
}

/* ---- Render product ---- */
function render(p) {
  const displayTitle = window.I18n ? window.I18n.productTitle(p) : (p.title || '');
  var brandSuffix = (window.I18n && window.I18n.lang === 'en') ? 'Avtonomka' : 'Автономка';
  document.title = displayTitle + ' - ' + brandSuffix;

  /* breadcrumb */
  const bcName = document.getElementById('bc-name');
  if (bcName) bcName.textContent = displayTitle;

  /* ---- Gallery ---- */
  const resolveImg = (src) => /^https?:\/\//.test(src) ? src : BASE + src;
  const images   = [p.image_link].filter(Boolean).map(resolveImg);
  const mainImg  = document.getElementById('gallery-main-img');
  const thumbsWrap = document.getElementById('gallery-thumbs');

  if (mainImg && images.length > 0) {
    mainImg.src = images[0];
    mainImg.alt = displayTitle;
    const galleryMain = mainImg.closest('.gallery-main');
    if (galleryMain) {
      galleryMain.addEventListener('click', () => openLightbox(images[0], displayTitle));
      galleryMain.querySelector('.product-card__badge-stack')?.remove();
      galleryMain.insertAdjacentHTML('beforeend', buildBadgeStackHtml(p, displayTitle));
    }
  }

  if (thumbsWrap) {
    thumbsWrap.style.display = 'none';
  }

  /* ---- Title ---- */
  const titleEl = document.getElementById('product-title');
  if (titleEl) titleEl.textContent = displayTitle;

  /* ---- Availability ---- */
  const availEl = document.getElementById('product-availability');
  if (availEl) {
    const inStock = p.availability === 'in_stock';
    availEl.textContent = inStock ? t('product.in_stock') : t('product.out_of_stock');
    availEl.className   = 'badge ' + (inStock ? 'badge-green' : 'badge-grey');
  }

  /* ---- Price ---- */
  const priceEl = document.getElementById('product-price');
  if (priceEl) priceEl.textContent = formatPrice(p.price || '') || '-';

  /* ---- Meta ---- */
  const mpnEl = document.getElementById('product-mpn');
  const catEl = document.getElementById('product-cat');
  if (mpnEl) mpnEl.textContent = p.mpn || '-';
  if (catEl) catEl.textContent = categoryLabel(p.product_type) || '-';

  /* ---- Description ---- */
  const descEl    = document.getElementById('product-desc');
  const descBlock = document.querySelector('.product-info__desc');
  const lang      = window.I18n ? window.I18n.lang : 'uk';

  if (descEl) {
    if (lang === 'en') {
      const enDesc = window.I18n ? window.I18n.productDesc(p) : '';
      const hasEnDesc = enDesc && enDesc !== (p.description || '');
      if (hasEnDesc) {
        descEl.textContent = enDesc;
      } else {
        /* No English translation - hide the whole description block */
        if (descBlock) descBlock.style.display = 'none';
      }
    } else {
      const clean = cleanDescription(p.description || '');
      descEl.textContent = clean || t('product.no_desc');
    }
  }

  /* ---- Specs table - hide in EN ---- */
  const specsEl = document.getElementById('product-specs');
  if (specsEl) {
    if (p.specs && lang === 'uk') {
      specsEl.innerHTML = p.specs;
    } else {
      specsEl.remove();
    }
  }

  /* ---- Embed video ---- */
  const embedEl = document.getElementById('product-embed');
  if (embedEl) {
    if (p.embed) {
      embedEl.innerHTML = `<iframe src="${p.embed}" width="100%" height="400" allow="autoplay" allowfullscreen style="border:none;border-radius:8px;display:block;margin-top:16px"></iframe>`;
    } else {
      embedEl.remove();
    }
  }

  /* ---- Add to cart button ---- */
  const cartBtn = document.getElementById('btn-add-cart');
  if (cartBtn) {
    const priceNum = parseFloat(p.price);
    cartBtn.setAttribute('data-id', p.id);
    cartBtn.setAttribute('data-title', displayTitle);
    cartBtn.setAttribute('data-price', isNaN(priceNum) ? '0' : priceNum.toFixed(2));
    cartBtn.setAttribute('data-currency', String(p.price || '').replace(/[\d.\s]+/, '').trim() || 'UAH');
    cartBtn.setAttribute('data-sku', p.mpn || '');
  }

  /* ---- Datasheet button(s) ----
     Kit (has link2): label each button with which component it's for and
     that component's model, taken from the two halves of the title
     ("<інвертор> + <акумулятор>"). Single product (link only): label with
     the product's own name. Sets text directly and drops data-i18n so the
     generic translation string doesn't overwrite it on a language switch. */
  const isKit = !!(p.link && p.link2 && /Комплект/i.test(p.product_type || ''));
  const [invModel, batModel] = isKit ? kitModelParts(p.title) : [null, null];

  const datasheetWrap = document.getElementById('product-datasheet-wrap');
  const datasheetBtn  = document.getElementById('btn-datasheet');
  if (datasheetWrap && datasheetBtn) {
    if (p.link) {
      datasheetBtn.href = resolveImg(p.link);
      datasheetBtn.removeAttribute('data-i18n');
      datasheetBtn.textContent = isKit
        ? '↓ Даташит для інвертора' + (invModel ? ': ' + invModel : '')
        : '↓ Скачати даташит для ' + (p.title || 'товару');
      datasheetWrap.classList.remove('hidden');
    } else {
      datasheetWrap.remove();
    }
  }

  const datasheetWrap2 = document.getElementById('product-datasheet-wrap-2');
  const datasheetBtn2  = document.getElementById('btn-datasheet-2');
  if (datasheetWrap2 && datasheetBtn2) {
    if (p.link2) {
      datasheetBtn2.href = resolveImg(p.link2);
      datasheetBtn2.removeAttribute('data-i18n');
      datasheetBtn2.textContent = '↓ Даташит для акумулятора' + (batModel ? ': ' + batModel : '');
      datasheetWrap2.classList.remove('hidden');
    } else {
      datasheetWrap2.remove();
    }
  }

  /* ---- Show content: only one state may exist in the DOM at a time ---- */
  document.getElementById('loading-state')?.remove();
  document.getElementById('not-found-state')?.remove();
  document.getElementById('error-state')?.remove();
  document.getElementById('product-content')?.classList.remove('hidden');
}

/* ---- State helpers: each removes the other three states from the DOM ---- */
function showNotFound() {
  document.getElementById('loading-state')?.remove();
  document.getElementById('error-state')?.remove();
  document.getElementById('product-content')?.remove();
  document.getElementById('not-found-state')?.classList.remove('hidden');
}

function showError() {
  document.getElementById('loading-state')?.remove();
  document.getElementById('not-found-state')?.remove();
  document.getElementById('product-content')?.remove();
  document.getElementById('error-state')?.classList.remove('hidden');
}

/* ---- Start: wait for i18n ---- */
if (window.I18n) {
  init();
} else {
  document.addEventListener('i18n:ready', init);
}
