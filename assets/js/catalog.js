/* catalog.js - завантаження та рендер товарів (self-contained) */

/* ---- Slug ↔ category mapping (для чистих URL) ---- */
const SLUG_TO_CATEGORY = {
  'hybridni-invertory':   'Автономна енергетика > Гибридні інвертори',
  'akumulyatory':         'Автономна енергетика > Акумулятори для гібридних інверторів',
  'komplekty':            'Автономна енергетика > Комплекти автономного енергоживлення',
  'kabeli':               'Автономна енергетика > Силові та сонячні кабелі',
  'dzherela-zhyvlennya':  'Обладнання > Джерела безперебійного живлення',
  'akumulyatory-dbzh':    'Акумулятори і батарейки > Акумулятори для ДБЖ',
  'systemy-zberihannya':  'Автономна енергетика > Системи зберігання електроенергії 2 в 1',
};

const CATEGORY_TO_SLUG = {};
Object.keys(SLUG_TO_CATEGORY).forEach(function(slug) {
  CATEGORY_TO_SLUG[SLUG_TO_CATEGORY[slug]] = slug;
});

/* ---- Facet filters — which categories get which, per product owner's
   request. komplekty gets separate "Інвертор" / "Акумулятор" brand lists
   (kitBrand) instead of one combined "brand", since a kit has two brands;
   "monobrand" is an extra checkbox meaning both halves are the same
   brand. ---- */
const FACET_CONFIG = {
  'hybridni-invertory':  { power: true, brand: true },
  'komplekty':           { power: true, kitBrand: true, monobrand: true },
  'akumulyatory':        { brand: true, capacity: true },
  'kabeli':              { crossSection: true, length: true, lugSize: true },
  'dzherela-zhyvlennya': { brand: true },
  'akumulyatory-dbzh':   { brand: true, capacity: true },
  'systemy-zberihannya': { power: true, brand: true },
};
const KNOWN_BRANDS = ['DAH Solar', 'Deye', 'Dyness', 'Felicity', 'Must', 'EcoFlow', 'TTN'];

function extractBrand(title) {
  if (!title) return null;
  for (const b of KNOWN_BRANDS) {
    const re = new RegExp('\\b' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (re.test(title)) return b;
  }
  return null;
}

/* Power rating in kW, parsed from the title - mirrors miniapp_v/index.html's
   extractKw() so the two stay consistent. (?!h) keeps "16kWh" (battery
   capacity) from being misread as power. */
function extractKw(title) {
  if (!title) return null;
  let m = title.match(/(\d+(?:[.,]\d+)?)\s*(?:кВт|kw)(?!h)/i);
  if (m) return m[1].replace(',', '.');
  m = title.match(/(\d+)\s*Вт\b/);
  if (m) return String(Number(m[1]) / 1000);
  m = title.match(/SUN-(\d+)K-/i);
  if (m) return m[1];
  m = title.match(/PV\d+-(\d{2})\d{2}/i); // MUST "PVxx-XXYY": XX/10 = кВт
  if (m) return String(Number(m[1]) / 10);
  return null;
}

/* Battery capacity in Ah, parsed from the title ("100Ah", "314 Аh" - note the
   source data mixes Latin and Cyrillic А). */
function extractAh(title) {
  if (!title) return null;
  const m = title.match(/(\d+(?:[.,]\d+)?)\s*[AaАа][hH]\b/);
  return m ? m[1].replace(',', '.') : null;
}

/* Cable length - "1 м", "50 см", "2050 мм", "500 м" (a reel). Checked in
   м → см → мм order, each rejecting a match immediately followed by another
   letter (so "мм" doesn't get eaten by the "м" pattern, "см" doesn't get
   eaten by "м" either, etc.) — plain \b doesn't work here since JS regex
   only treats ASCII as "word" characters, not Cyrillic. */
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

/* Convert an extractLength() value back to mm, purely so the facet checkbox
   list can be sorted by actual physical length instead of alphabetically
   (which would put "500 м" before "50 см"). */
function lengthToMm(label) {
  const m = label.match(/^(\d+(?:\.\d+)?)\s*(мм|см|м)$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'мм') return n;
  if (unit === 'см') return n * 10;
  return n * 1000;
}

/* Cable cross-section - "25 мм" / "6 мм" (mm²) or "4AWG" for the Dyness set.
   AWG is checked first since that title also contains an unrelated "2050мм"
   (length), which would otherwise falsely match the мм pattern. */
/* 4 AWG ≈ 21.1 mm², rounded to 21 per common practice - shown in the metric
   unit the rest of the catalog uses, rather than AWG. Extend this table if a
   different AWG gauge is ever added; unmapped gauges fall back to "N AWG". */
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

/* Lug/terminal thread size - "мідні накінечники М8" / "...М10". */
function extractLugSize(title) {
  if (!title) return null;
  const m = title.match(/накінечники\s*(М\d+)/i);
  return m ? m[1].toUpperCase() : null;
}

/* "Комплект автономного енергоживлення: <inverter> + <battery>" -> the brand
   of each half, keeping the [inverter, battery] position (null if a half's
   brand isn't recognized) so the inverter/battery facets can be extracted
   independently. */
function kitBrandParts(title) {
  const body = (title || '').replace(/^Комплект автономного енергоживлення:\s*/i, '');
  const parts = body.split(/\s*\+\s*/);
  if (parts.length !== 2) return [null, null];
  return [extractBrand(parts[0]), extractBrand(parts[1])];
}

function kitInverterBrand(title) { return kitBrandParts(title)[0]; }
function kitBatteryBrand(title)  { return kitBrandParts(title)[1]; }

function isMonobrand(title) {
  const [inv, bat] = kitBrandParts(title);
  return !!inv && !!bat && inv === bat;
}

/* Battery capacity in kWh for a kit, from the battery half of the title.
   Prefers an explicitly stated "16kWh" when present; otherwise computes it
   from voltage × Ah (both are always present on the battery half). */
function extractKitBatteryKwh(title) {
  const body = (title || '').replace(/^Комплект автономного енергоживлення:\s*/i, '');
  const parts = body.split(/\s*\+\s*/);
  if (parts.length !== 2) return null;
  const battery = parts[1];

  let m = battery.match(/(\d+(?:[.,]\d+)?)\s*kWh/i);
  if (m) return parseFloat(m[1].replace(',', '.'));

  const v  = battery.match(/(\d+(?:[.,]\d+)?)\s*V\b/i);
  const ah = battery.match(/(\d+(?:[.,]\d+)?)\s*[AaАа][hH]\b/);
  if (v && ah) {
    return Math.round(parseFloat(v[1].replace(',', '.')) * parseFloat(ah[1].replace(',', '.')) / 10) / 100;
  }
  return null;
}

/* "Легкий" / "Оптимальний" / "Супер запасливий" status badge, by battery
   capacity - per product owner's thresholds: ≤5 / ≤12 / >12 kWh. */
function kitStatusTier(title) {
  const kwh = extractKitBatteryKwh(title);
  if (kwh === null) return null;
  if (kwh <= 5) return 'light';
  if (kwh <= 12) return 'optimal';
  return 'super';
}

/* Brand for the plain single-brand facet (everything except komplekty,
   which has its own separate inverter/battery lists). */
function productBrands(p) {
  const title = window.I18n ? window.I18n.productTitle(p) : (p.title || '');
  const b = extractBrand(title);
  return b ? [b] : [];
}

function categoryLabel(productType) {
  if (!productType) return '';
  var slug = CATEGORY_TO_SLUG[productType];
  if (slug && window.I18n) {
    var label = window.I18n.t('categories.' + slug);
    if (label && label !== 'categories.' + slug) return label;
  }
  return productType.split('>').pop().trim();
}

const ITEMS_PER_PAGE = 24;

let allProducts      = [];
let filtered         = [];
let currentPage      = 1;
let selectedCategory = '';
let selectedPowers          = new Set();
let selectedBrands          = new Set();
let selectedInverterBrands  = new Set();
let selectedBatteryBrands   = new Set();
let monobrandOnly           = false;
let selectedCapacities      = new Set();
let selectedCrossSections   = new Set();
let selectedLengths         = new Set();
let selectedLugSizes        = new Set();

/* ---- Local helpers ---- */
function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len).trimEnd() + '…' : str;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPrice(raw) {
  if (!raw) return '';
  const num = parseFloat(raw);
  if (isNaN(num)) return raw;
  const currency = raw.replace(/[\d.\s]+/, '').trim() || 'UAH';
  return num.toLocaleString('uk-UA', { maximumFractionDigits: 0 }) + ' ' + currency;
}

/* "ТОП" badge on a fixed-but-random-looking ~1-in-7 subset of products -
   deterministic hash of the id so the same items stay marked TOP across
   catalog cards, the product page and the static pre-rendered HTML,
   instead of reshuffling on every reload. */
function isTopProduct(id) {
  let hash = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return hash % 4 === 0;
}

/* ---- t() shortcut - waits for I18n or falls back ---- */
function t(key, vars) {
  if (window.I18n) return window.I18n.t(key, vars);
  return key;
}

/* ---- Base paths (override via window.PRODUCTS_URL / PRODUCT_BASE_URL / ASSETS_BASE) ---- */
const _productsUrl   = (typeof PRODUCTS_URL    !== 'undefined' && PRODUCTS_URL)    || 'products.json';
const _productBase   = (typeof PRODUCT_BASE_URL !== 'undefined' && PRODUCT_BASE_URL) || 'product/';
const _assetsBase    = (typeof ASSETS_BASE      !== 'undefined' && ASSETS_BASE)     || '';

/* ---- Віртуальні товари (public.virtual_products, розділ 9.4
   ARCHITECTURE.md) НЕ показуються в каталозі сайту (ані сітка, ані пошук).
   Вони лишаються лише як окремі SEO-сторінки product/<slug>/<id>.html і в
   sitemap.xml — генеруються scripts/generate_static_pages.js. Тому тут їх
   більше не підмішуємо. ---- */

/* ---- DOM refs ---- */
const grid        = document.getElementById('products-grid');
const counter     = document.getElementById('catalog-counter');
const pagination  = document.getElementById('pagination');
const searchInput = document.getElementById('filter-search');
const catMenu     = document.getElementById('filter-category-menu');
const facetsPanel = document.getElementById('filter-facets');
const sortSelect  = document.getElementById('filter-sort');

/* ---- Init - wait for i18n then load ---- */
function init() {
  if (!grid) return;
  showLoading();

  fetch(_productsUrl)
    .then(function(resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    })
    .then(function(data) {
      allProducts = (Array.isArray(data) ? data : (data.products || []));
      const rawCat = (typeof PRESET_CATEGORY !== 'undefined' && PRESET_CATEGORY)
        || new URLSearchParams(window.location.search).get('cat')
        || '';
      selectedCategory = rawCat ? (SLUG_TO_CATEGORY[rawCat] || rawCat) : '';
      populateCategories();
      renderFacets();
      applyFilters();
    })
    .catch(function(e) {
      showError();
      console.error('Помилка завантаження products.json:', e);
    });
}

/* Switch category: reset any facet selections (they're category-specific),
   rebuild the facet panel for the new category, then re-filter. */
function selectCategory(type) {
  selectedCategory      = type;
  selectedPowers        = new Set();
  selectedBrands        = new Set();
  selectedInverterBrands = new Set();
  selectedBatteryBrands  = new Set();
  monobrandOnly         = false;
  selectedCapacities    = new Set();
  selectedCrossSections = new Set();
  selectedLengths       = new Set();
  selectedLugSizes      = new Set();
  setActiveMenuState();
  renderFacets();
  applyFilters();
}

/* ---- Populate always-open category menu ---- */
function populateCategories() {
  if (!catMenu) return;
  const types = [...new Set(allProducts.map(p => p.product_type).filter(Boolean))].sort();

  const allBtn = catMenu.querySelector('.category-menu__item[data-cat=""]');
  if (allBtn && !allBtn.querySelector('.category-menu__count')) {
    const countSpan = document.createElement('span');
    countSpan.className = 'category-menu__count';
    countSpan.textContent = allProducts.length;
    allBtn.appendChild(countSpan);
  }

  types.forEach(function(type) {
    const count = allProducts.filter(p => p.product_type === type).length;

    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'category-menu__item';
    btn.dataset.cat = type;
    btn.innerHTML = `<span>${escapeHtml(categoryLabel(type))}</span><span class="category-menu__count">${count}</span>`;
    btn.addEventListener('click', () => selectCategory(type));
    li.appendChild(btn);

    catMenu.appendChild(li);
  });

  setActiveMenuState();
}

/* ---- Sync .is-active class in the category menu with current selection ---- */
function setActiveMenuState() {
  if (!catMenu) return;
  catMenu.querySelectorAll('.category-menu__item').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.cat === selectedCategory);
  });
}

/* ---- Facet panel (power / brand / monobrand checkboxes) for the active category ---- */
function renderFacets() {
  if (!facetsPanel) return;
  const slug   = CATEGORY_TO_SLUG[selectedCategory];
  const facets = slug && FACET_CONFIG[slug];

  if (!facets) {
    facetsPanel.innerHTML = '';
    facetsPanel.hidden = true;
    return;
  }

  const inCategory = allProducts.filter(p => p.product_type === selectedCategory);
  let html = '';

  /* Generic "extract a value from the title, count distinct values, render
     a checkbox per value" group - used for power/capacity/length/lug size.
     `sort` is either true (plain numeric via parseFloat), a custom
     comparator (needed when the label mixes units, e.g. length), or falsy
     for alphabetical. Brand (with its monobrand extra checkbox) is handled
     separately below since it needs productBrands() instead of a plain
     extractor. */
  function renderNumericFacet(titleKey, dataFacet, extractFn, selectedSet, unit, sort) {
    const counts = {};
    inCategory.forEach(p => {
      const title = window.I18n ? window.I18n.productTitle(p) : (p.title || '');
      const v = extractFn(title);
      if (v !== null) counts[v] = (counts[v] || 0) + 1;
    });
    const cmp = typeof sort === 'function' ? sort : (sort ? (a, b) => parseFloat(a) - parseFloat(b) : undefined);
    const values = Object.keys(counts).sort(cmp);
    if (!values.length) return;
    html += `<div class="facet-group"><div class="facet-group__title">${escapeHtml(t(titleKey))}</div>`;
    values.forEach(v => {
      const label = unit ? `${escapeHtml(v)} ${escapeHtml(unit)}` : escapeHtml(v);
      html += `<label class="facet-checkbox"><input type="checkbox" data-facet="${dataFacet}" value="${escapeHtml(v)}" ${selectedSet.has(v) ? 'checked' : ''}><span>${label}</span><span class="facet-checkbox__count">${counts[v]}</span></label>`;
    });
    html += `</div>`;
  }

  if (facets.power)        renderNumericFacet('catalog.facet_power', 'power', extractKw, selectedPowers, t('catalog.facet_power_unit'), true);
  if (facets.capacity)     renderNumericFacet('catalog.facet_capacity', 'capacity', extractAh, selectedCapacities, 'Ah', true);
  if (facets.crossSection) renderNumericFacet('catalog.facet_cross_section', 'crossSection', extractCrossSection, selectedCrossSections, '', true);
  if (facets.length)       renderNumericFacet('catalog.facet_length', 'length', extractLength, selectedLengths, '', (a, b) => lengthToMm(a) - lengthToMm(b));
  if (facets.lugSize)      renderNumericFacet('catalog.facet_lug_size', 'lugSize', extractLugSize, selectedLugSizes, '', false);

  if (facets.brand) {
    const counts = {};
    inCategory.forEach(p => {
      productBrands(p).forEach(b => { counts[b] = (counts[b] || 0) + 1; });
    });
    const values = Object.keys(counts).sort();
    if (values.length) {
      html += `<div class="facet-group"><div class="facet-group__title">${escapeHtml(t('catalog.facet_brand'))}</div>`;
      values.forEach(v => {
        html += `<label class="facet-checkbox"><input type="checkbox" data-facet="brand" value="${escapeHtml(v)}" ${selectedBrands.has(v) ? 'checked' : ''}><span>${escapeHtml(v)}</span><span class="facet-checkbox__count">${counts[v]}</span></label>`;
      });
      html += `</div>`;
    }
  }

  /* komplekty: two separate brand lists (the kit has an inverter AND a
     battery, each potentially a different brand), plus a standalone
     "Монобренд" checkbox for kits where both halves match. */
  if (facets.kitBrand) {
    renderNumericFacet('catalog.facet_inverter_brand', 'inverterBrand', kitInverterBrand, selectedInverterBrands, '', false);
    renderNumericFacet('catalog.facet_battery_brand', 'batteryBrand', kitBatteryBrand, selectedBatteryBrands, '', false);
  }

  if (facets.monobrand) {
    const monoCount = inCategory.filter(p => {
      const title = window.I18n ? window.I18n.productTitle(p) : (p.title || '');
      return isMonobrand(title);
    }).length;
    html += `<div class="facet-group"><label class="facet-checkbox facet-checkbox--mono"><input type="checkbox" data-facet="monobrand" ${monobrandOnly ? 'checked' : ''}><span>${escapeHtml(t('catalog.facet_monobrand'))}</span><span class="facet-checkbox__count">${monoCount}</span></label></div>`;
  }

  facetsPanel.innerHTML = html;
  facetsPanel.hidden = !html;

  [
    ['power', selectedPowers],
    ['capacity', selectedCapacities],
    ['crossSection', selectedCrossSections],
    ['length', selectedLengths],
    ['lugSize', selectedLugSizes],
    ['brand', selectedBrands],
    ['inverterBrand', selectedInverterBrands],
    ['batteryBrand', selectedBatteryBrands],
  ].forEach(([key, set]) => {
    facetsPanel.querySelectorAll(`input[data-facet="${key}"]`).forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) set.add(cb.value); else set.delete(cb.value);
        applyFilters();
      });
    });
  });
  facetsPanel.querySelectorAll('input[data-facet="monobrand"]').forEach(cb => {
    cb.addEventListener('change', () => {
      monobrandOnly = cb.checked;
      applyFilters();
    });
  });
}

/* ---- Filter + sort ---- */
function applyFilters() {
  const query  = (searchInput ? searchInput.value : '').trim().toLowerCase();
  const cat    = selectedCategory;
  const slug   = CATEGORY_TO_SLUG[cat];
  const facets = slug && FACET_CONFIG[slug];
  const availEl = document.querySelector('input[name="availability"]:checked');
  const avail = availEl ? availEl.value : 'all';
  const sort  = sortSelect ? sortSelect.value : 'name_asc';

  filtered = allProducts.filter(p => {
    const title = window.I18n ? window.I18n.productTitle(p) : (p.title || '');
    if (query && !title.toLowerCase().includes(query)) return false;
    if (cat && p.product_type !== cat) return false;
    if (facets) {
      if (facets.power && selectedPowers.size) {
        const kw = extractKw(title);
        if (kw === null || !selectedPowers.has(kw)) return false;
      }
      if (facets.capacity && selectedCapacities.size) {
        const ah = extractAh(title);
        if (ah === null || !selectedCapacities.has(ah)) return false;
      }
      if (facets.crossSection && selectedCrossSections.size) {
        const cs = extractCrossSection(title);
        if (cs === null || !selectedCrossSections.has(cs)) return false;
      }
      if (facets.length && selectedLengths.size) {
        const len = extractLength(title);
        if (len === null || !selectedLengths.has(len)) return false;
      }
      if (facets.lugSize && selectedLugSizes.size) {
        const ls = extractLugSize(title);
        if (ls === null || !selectedLugSizes.has(ls)) return false;
      }
      if (facets.brand && selectedBrands.size) {
        const brands = productBrands(p);
        if (!brands.some(b => selectedBrands.has(b))) return false;
      }
      if (facets.kitBrand) {
        if (selectedInverterBrands.size) {
          const inv = kitInverterBrand(title);
          if (!inv || !selectedInverterBrands.has(inv)) return false;
        }
        if (selectedBatteryBrands.size) {
          const bat = kitBatteryBrand(title);
          if (!bat || !selectedBatteryBrands.has(bat)) return false;
        }
      }
      if (facets.monobrand && monobrandOnly && !isMonobrand(title)) return false;
    }
    if (avail === 'in_stock' && p.availability !== 'in_stock') return false;
    return true;
  });

  filtered.sort((a, b) => {
    const pa = parseFloat(a.price) || 0;
    const pb = parseFloat(b.price) || 0;
    if (sort === 'price_asc')  return pa - pb;
    if (sort === 'price_desc') return pb - pa;
    const ta = window.I18n ? window.I18n.productTitle(a) : (a.title || '');
    const tb = window.I18n ? window.I18n.productTitle(b) : (b.title || '');
    if (sort === 'name_asc')   return ta.localeCompare(tb);
    if (sort === 'name_desc')  return tb.localeCompare(ta);
    return 0;
  });

  currentPage = 1;
  render();
}

/* ---- Render current page ---- */
function render() {
  const total = filtered.length;
  const start = (currentPage - 1) * ITEMS_PER_PAGE;
  const end   = Math.min(start + ITEMS_PER_PAGE, total);
  const page  = filtered.slice(start, end);

  if (counter) {
    counter.textContent = total === 0
      ? t('catalog.counter_none')
      : t('catalog.counter', { start: start + 1, end: end, total: total });
  }

  grid.innerHTML = '';

  if (page.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <img src="${_assetsBase}assets/images/sticker.webp" alt="" loading="lazy">
        <h3>${t('catalog.empty_title')}</h3>
        <p>${t('catalog.empty_text')}</p>
      </div>`;
    if (pagination) pagination.innerHTML = '';
    return;
  }

  page.forEach(p => grid.insertAdjacentHTML('beforeend', renderCard(p)));
  renderPagination(total);
}

/* ---- Card HTML ---- */
function renderCard(p) {
  const inStock  = p.availability === 'in_stock';
  const availabilityText = inStock ? t('catalog.in_stock') : t('catalog.out_of_stock');
  const priceStr = formatPrice(p.price || '');
  const displayTitle = window.I18n ? window.I18n.productTitle(p) : (p.title || '');
  const title    = truncate(displayTitle, 80);
  const img      = p.image_link ? (/^https?:\/\//.test(p.image_link) ? p.image_link : _assetsBase + p.image_link) : (_assetsBase + 'assets/images/zaglushka.png');
  const zagl     = _assetsBase + 'assets/images/zaglushka.png';
  const href     = `${_productBase}${encodeURIComponent(p.slug || p.id)}/${encodeURIComponent(p.id)}.html`;

  /* Kit-only badges: mono-brand, "Легкий/Оптимальний/Супер запасливий"
     capacity tier, and an installment tag - all stacked as small pills over
     the top-left corner of the image, availability included. */
  const topBadgeHtml = isTopProduct(p.id) ? `<span class="product-card__pill product-card__pill--top">${escapeHtml(t('catalog.top_badge'))}</span>` : '';

  const isKit = CATEGORY_TO_SLUG[p.product_type] === 'komplekty';
  let stackExtraHtml = '';
  let installmentNoteHtml = '';
  if (isKit) {
    let monobrandBadgeHtml = '';
    let tierBadgeHtml = '';
    const [invBrand, batBrand] = kitBrandParts(displayTitle);
    if (invBrand && invBrand === batBrand) {
      monobrandBadgeHtml = `<span class="product-card__pill product-card__pill--monobrand">${escapeHtml(t('catalog.monobrand_badge'))} ${escapeHtml(invBrand)}</span>`;
    }
    const tier = kitStatusTier(displayTitle);
    if (tier) {
      tierBadgeHtml = `<span class="product-card__pill product-card__pill--tier-${tier}">${escapeHtml(t('catalog.tier_' + tier))}</span>`;
    }
    stackExtraHtml = `<span class="product-card__pill product-card__pill--installment">${escapeHtml(t('catalog.installment_badge'))}</span>${tierBadgeHtml}${monobrandBadgeHtml}`;
    installmentNoteHtml = `<div class="product-card__installment-note">${escapeHtml(t('catalog.installment_note'))}</div>`;
  }

  /* Cable-only spec pills: cross-section, lug size, length - whichever the
     title actually has (same extractors the "Кабелі" facets use), stacked
     over the image like the kit badges. */
  let cableSpecsHtml = '';
  if (CATEGORY_TO_SLUG[p.product_type] === 'kabeli') {
    const cs = extractCrossSection(displayTitle);
    if (cs) cableSpecsHtml += `<span class="product-card__pill product-card__pill--spec">⌀ ${escapeHtml(cs)}</span>`;
    const ls = extractLugSize(displayTitle);
    if (ls) cableSpecsHtml += `<span class="product-card__pill product-card__pill--spec">🔩 ${escapeHtml(ls)}</span>`;
    const len = extractLength(displayTitle);
    if (len) cableSpecsHtml += `<span class="product-card__pill product-card__pill--spec">📏 ${escapeHtml(len)}</span>`;
  }

  return `
  <div class="product-card">
    <a href="${href}" class="product-card__img-wrap" aria-label="${escapeHtml(title)}">
      <img src="${escapeHtml(img)}"
           alt="${escapeHtml(displayTitle)}"
           loading="lazy"
           onerror="this.src='${zagl}'">
      <div class="product-card__badge-stack">
        ${topBadgeHtml}
        ${isKit ? '' : `<span class="product-card__pill product-card__pill--${inStock ? 'in-stock' : 'out-of-stock'}">${escapeHtml(availabilityText)}</span>`}
        ${stackExtraHtml}
        ${cableSpecsHtml}
      </div>
    </a>
    <div class="product-card__body">
      <a href="${href}" class="product-card__title">${escapeHtml(title)}</a>
      <div class="product-card__price-row">
        <span class="product-card__price">${escapeHtml(priceStr)}</span>
        ${p.mpn ? `<span class="product-card__sku">${t('catalog.article')} ${escapeHtml(p.mpn)}</span>` : ''}
      </div>
      ${installmentNoteHtml}
    </div>
    <div class="product-card__footer">
      <a href="${href}" class="btn btn-block">
        ${t('catalog.details')}
      </a>
      <button type="button" class="btn btn-cart btn-block" data-add-to-cart
              data-id="${escapeHtml(p.id)}" data-title="${escapeHtml(displayTitle)}"
              data-price="${isNaN(parseFloat(p.price)) ? '0' : parseFloat(p.price).toFixed(2)}"
              data-currency="${escapeHtml(String(p.price || '').replace(/[\d.\s]+/, '').trim() || 'UAH')}"
              data-sku="${escapeHtml(p.mpn || '')}">
        🛒 ${t('catalog.add_to_cart')}
      </button>
      <a href="${_assetsBase}return-policy.html#return" class="product-card__return-link">${t('catalog.return_policy')}</a>
    </div>
  </div>`;
}

/* ---- Pagination ---- */
function renderPagination(total) {
  if (!pagination) return;
  const pages = Math.ceil(total / ITEMS_PER_PAGE);
  if (pages <= 1) { pagination.innerHTML = ''; return; }

  let html = `<button class="page-btn" ${currentPage === 1 ? 'disabled' : ''} data-page="${currentPage - 1}">&#8592;</button>`;

  buildPageRange(currentPage, pages).forEach(p => {
    if (p === '...') {
      html += `<span style="padding:0 6px;color:var(--color-muted)">…</span>`;
    } else {
      html += `<button class="page-btn ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
    }
  });

  html += `<button class="page-btn" ${currentPage === pages ? 'disabled' : ''} data-page="${currentPage + 1}">&#8594;</button>`;
  pagination.innerHTML = html;

  pagination.querySelectorAll('.page-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      currentPage = +btn.dataset.page;
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
}

function buildPageRange(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const range = [1];
  if (current > 3) range.push('...');
  for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) range.push(i);
  if (current < total - 2) range.push('...');
  range.push(total);
  return range;
}

/* ---- Loading / Error states ---- */
function showLoading() {
  grid.innerHTML = `
    <div class="loading-state" style="grid-column:1/-1">
      <div class="spinner"></div>
      <span>${t('catalog.loading_text')}</span>
    </div>`;
}

function showError() {
  grid.innerHTML = `
    <div class="empty-state" style="grid-column:1/-1">
      <img src="${_assetsBase}assets/images/sticker.webp" alt="" loading="lazy">
      <h3>${t('catalog.error_title')}</h3>
      <p>${t('catalog.error_text')}</p>
    </div>`;
}

/* ---- Event listeners ---- */
function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

if (searchInput) searchInput.addEventListener('input', debounce(applyFilters, 250));
if (sortSelect)  sortSelect.addEventListener('change', applyFilters);

document.querySelector('.category-menu__item[data-cat=""]')?.addEventListener('click', () => selectCategory(''));

document.querySelectorAll('input[name="availability"]').forEach(r =>
  r.addEventListener('change', applyFilters)
);

document.getElementById('filter-reset')?.addEventListener('click', () => {
  if (searchInput) searchInput.value = '';
  if (sortSelect)  sortSelect.value  = 'name_asc';
  const allRadio = document.querySelector('input[name="availability"][value="all"]');
  if (allRadio) allRadio.checked = true;
  selectCategory('');
});

/* ---- Start: wait for i18n, then init ---- */
if (window.I18n) {
  init();
} else {
  document.addEventListener('i18n:ready', init);
}
