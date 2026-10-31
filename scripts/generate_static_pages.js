/**
 * Generates static, crawlable HTML for Google Merchant Center compliance.
 *
 * Problem: product.html is one shared template for all products (?id=X) and
 * catalog.html / catalog/*.html render their product grids entirely via
 * client-side JS from products.json. view-source on any of these pages shows
 * only "Завантаження…" — no price/title/availability without executing JS.
 *
 * This script (run at build time, same place as generate_merchant_feed.js):
 *   1. Generates one static file per product at product/<id>.html with the
 *      real title/price/availability/description already in the HTML, plus
 *      a schema.org Product/Offer JSON-LD block.
 *   2. Prerenders the first page (default sort, no filters — exactly what
 *      catalog.js shows on first load) of product cards into catalog.html
 *      and each catalog/<slug>.html, wrapped in <!-- SSR:START/END -->
 *      markers so re-runs are idempotent.
 *   3. Same idea for the Telegram-feed and articles LIST views (not the
 *      full article body, which only ever opens via JS hash-routing and
 *      isn't a separately crawlable URL anyway): blog.html's #blog-grid,
 *      articles.html's #articles-grid, and the two homepage previews
 *      (#home-tg-feed, #home-articles-grid) get their card markup baked
 *      into the HTML too, wrapped in their own SSR:TG/SSR:ARTICLES markers.
 *      assets/js/blog.js and assets/js/articles.js still run on top and
 *      simply overwrite this with the same markup (plus live view counts) -
 *      it's a crawler-visible fallback, not a caching layer to invalidate.
 *
 * product.html itself (the old ?id=X template) is left completely untouched
 * and keeps working exactly as before — nothing links to it going forward,
 * but old bookmarks/indexed URLs won't break.
 *
 * Run: node scripts/generate_static_pages.js
 */

const fs      = require('fs');
const path    = require('path');
const { execFileSync } = require('child_process');
const { slugify } = require('./slugify');
const { cleanTitle } = require('./clean_title');
const { getBackorderOffer, PAGE_SUFFIX } = require('./backorder');

const ROOT           = path.join(__dirname, '..');
const SITE_URL        = 'https://avtonomka.com.ua';
// Старі адреси знятих товарів -> 301 на категорію (або на той самий товар під
// новою адресою), щоб Google не бачив 404. Поповнюється автоматично, коли
// генератор видаляє сторінку знятого товару (див. generateAllProductPages).
const REMOVED_REDIRECTS_FILE = path.join(__dirname, '..', 'data', 'removed_product_redirects.json');
const ITEMS_PER_PAGE  = 24;
const TODAY           = new Date().toISOString().slice(0, 10);

/* Real last-modified date for a file: today if its content changed in this
   very run (before that change is committed, git doesn't know about it yet),
   otherwise the committer date of its last actual change in git history.
   This is what keeps sitemap.xml's <lastmod> honest instead of stamping
   every URL with "whenever the script last ran". */
function lastmodFor(relPath, changedNow) {
  if (changedNow) return TODAY;
  try {
    const out = execFileSync(
      'git', ['log', '-1', '--format=%cs', '--', relPath],
      { cwd: ROOT, encoding: 'utf8' }
    ).trim();
    if (out) return out;
  } catch (e) {
    // not a git checkout / git unavailable — fall through
  }
  return TODAY;
}

const SLUG_TO_CATEGORY = {
  'hybridni-invertory':   'Автономна енергетика > Гибридні інвертори',
  'akumulyatory':         'Автономна енергетика > Акумулятори для гібридних інверторів',
  'komplekty':            'Автономна енергетика > Комплекти автономного енергоживлення',
  'kabeli':               'Автономна енергетика > Силові та сонячні кабелі',
  'dzherela-zhyvlennya':  'Обладнання > Джерела безперебійного живлення',
  'akumulyatory-dbzh':    'Акумулятори і батарейки > Акумулятори для ДБЖ',
  'systemy-zberihannya':  'Автономна енергетика > Системи зберігання електроенергії 2 в 1',
  'wifi-moduli':          'Автономна енергетика > Wi-Fi модули для гібридних інверторів',
};
const CATEGORY_LABEL_UK = {
  'hybridni-invertory':   'Гібридні інвертори',
  'akumulyatory':         'Акумулятори для гібридних інверторів',
  'komplekty':            'Комплекти автономного енергоживлення',
  'kabeli':               'Силові та сонячні кабелі',
  'dzherela-zhyvlennya':  'Джерела безперебійного живлення',
  'akumulyatory-dbzh':    'Акумулятори для ДБЖ',
  'systemy-zberihannya':  'Системи зберігання енергії',
  'wifi-moduli':          'Wi-Fi модулі для інверторів',
};
const CATEGORY_TO_SLUG = {};
Object.keys(SLUG_TO_CATEGORY).forEach(slug => { CATEGORY_TO_SLUG[SLUG_TO_CATEGORY[slug]] = slug; });

/* ============================================================
   Shared helpers — mirror assets/js/catalog.js and product.js
   exactly, so prerendered HTML never disagrees with the JS render.
   ============================================================ */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len).trimEnd() + '…' : str;
}

function formatPrice(raw) {
  if (!raw) return '';
  const num = parseFloat(raw);
  if (isNaN(num)) return raw;
  const currency = raw.replace(/[\d.\s]+/, '').trim() || 'UAH';
  return num.toLocaleString('uk-UA', { maximumFractionDigits: 0 }) + ' ' + currency;
}

function priceCurrency(raw) {
  if (!raw) return 'UAH';
  return raw.replace(/[\d.\s]+/, '').trim() || 'UAH';
}

/* Verbatim copy of product.js:cleanDescription() */
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

function categoryLabel(productType) {
  if (!productType) return '';
  const slug = CATEGORY_TO_SLUG[productType];
  if (slug && CATEGORY_LABEL_UK[slug]) return CATEGORY_LABEL_UK[slug];
  return productType.split('>').pop().trim();
}

function absoluteUrl(url) {
  if (!url) return '';
  return url.startsWith('http') ? url : `${SITE_URL}/${url.replace(/^\//, '')}`;
}

function productSlug(p) {
  return p.slug || slugify(p.title || '');
}

function productUrl(p) {
  return `${SITE_URL}/product/${productSlug(p)}/${encodeURIComponent(p.id)}.html`;
}

/* Окрема сторінка варіанта «під замовлення» (scripts/backorder_offers.json),
   лежить поруч з основною: /product/<slug>/<id>-pid-zamovlennya.html */
function orderPageFile(p) {
  return `${encodeURIComponent(p.id)}${PAGE_SUFFIX}.html`;
}

function orderUrl(p) {
  return `${SITE_URL}/product/${productSlug(p)}/${orderPageFile(p)}`;
}

/* Old flat URL — kept alive as a redirect stub, not a real page anymore. */
function legacyProductUrl(p) {
  return `${SITE_URL}/product/${encodeURIComponent(p.id)}.html`;
}

/* Manufacturer brand, detected from the title against a known-brand list —
   never guessed/invented. A kit combining two different brands (e.g.
   "Felicity IVEM... + DAH Solar ...") matches more than one and is left
   without a brand, since neither alone would be accurate. */
const KNOWN_BRANDS = [
  [/DAH\s*Solar/i,  'DAH Solar'],
  [/Dyness/i,        'Dyness'],
  [/Deye/i,          'Deye'],
  [/Felicity/i,      'Felicity'],
  [/\bMUST\b/i,      'MUST'],
  [/\bKBE\b/i,       'KBE'],
  [/EcoFlow/i,       'EcoFlow'],
  [/\bTTN\b/,        'TTN'],
];

function detectBrand(title) {
  if (!title) return null;
  const found = new Set();
  for (const [re, name] of KNOWN_BRANDS) {
    if (re.test(title)) found.add(name);
  }
  return found.size === 1 ? [...found][0] : null;
}

/* Kit-only badges (Комплекти автономного енергоживлення), mirrors the same
   logic in assets/js/catalog.js — keep both in sync. */
const KIT_FACET_BRANDS = ['DAH Solar', 'Deye', 'Dyness', 'Felicity', 'Must', 'EcoFlow', 'TTN'];
function extractKitHalfBrand(text) {
  if (!text) return null;
  for (const b of KIT_FACET_BRANDS) {
    const re = new RegExp('\\b' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (re.test(text)) return b;
  }
  return null;
}
function kitBrandParts(title) {
  const body = (title || '').replace(/^Комплект автономного енергоживлення:\s*/i, '');
  const parts = body.split(/\s*\+\s*/);
  if (parts.length !== 2) return [null, null];
  return [extractKitHalfBrand(parts[0]), extractKitHalfBrand(parts[1])];
}
function isMonobrand(title) {
  const [inv, bat] = kitBrandParts(title);
  return !!inv && !!bat && inv === bat;
}
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
function kitStatusTier(title) {
  const kwh = extractKitBatteryKwh(title);
  if (kwh === null) return null;
  if (kwh <= 5) return 'light';
  if (kwh <= 12) return 'optimal';
  return 'super';
}
const TIER_LABELS = { light: 'Легкий', optimal: 'Оптимальний', super: 'Супер запасливий' };

/* Cable spec extractors - mirrors assets/js/catalog.js, keep both in sync. */
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

/* Mirrors isTopProduct() in assets/js/catalog.js and assets/js/product.js -
   same deterministic hash, so the static pre-rendered cards agree with the
   client-side render instead of flickering on hydration. */
function isTopProduct(id) {
  let hash = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return hash % 4 === 0;
}

function loadProducts() {
  let raw = fs.readFileSync(path.join(ROOT, 'products.json'), 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  const data = JSON.parse(raw);
  return Array.isArray(data) ? data : (data.products || []);
}

/* Статті живуть у Supabase (public.articles), не в data/articles.json -
   читання публічне (RLS: anon can read articles). ⚠ Ці значення мають
   збігатися з assets/js/articles.js, index.html і admin.html. */
const SUPABASE_URL = 'https://uvndubhmqzqqsrnrxgaj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2bmR1YmhtcXpxcXNybnJ4Z2FqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzNDY4MDIsImV4cCI6MjEwMzkyMjgwMn0.AavrYyhDXBQkjKOMdQ9wAQX6B901dOfUpmtUDwO5Cv8';

/* Статті, для "Читайте також" на сторінках товару й для SSR-блоків
   articles.html/blog.html/index.html (розділ generateTelegramAndArticles).
   Мережева помилка не зупиняє build - просто немає статей у цьому запуску,
   як і раніше було з відсутнім/непарсним data/articles.json. */
async function loadArticles() {
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/articles?select=*`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('generate_static_pages: could not load articles from Supabase:', e.message);
    return [];
  }
}

/* Віртуальні товари (public.virtual_products) - SEO-заглушки для моделей
   постачальника, яких нема в products.json (розділ 9.4 ARCHITECTURE.md).
   Мапляться в той самий "product"-формат, що й products.json, і йдуть в
   generateAllProductPages/sitemap/.htaccess разом з реальними товарами,
   АЛЕ НЕ в generateCatalogGrids - у каталозі сайту (сітка + пошук) їх нема,
   лишаються тільки окремі сторінки product/<slug>/<id>.html для індексації.
   Позначені virtual:true - сторінка рендериться без ціни, зі статусом
   "Під замовлення" (ціни віртуальних не оновлюються автоматично, тож
   показувати конкретне число, яке потім розійдеться з реальним, не можна).
   НЕ в products.json, тому НЕ потрапляють у catalog_export.csv чи feed.xml
   (Google Merchant). Мережева помилка не зупиняє build. */
async function loadVirtualProducts() {
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/virtual_products?select=*`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const rows = await resp.json();
    return (Array.isArray(rows) ? rows : []).map(r => ({
      id: r.id,
      title: cleanTitle(r.title),
      image_link: r.image,
      additional_images: [],
      price: '',
      availability: 'backorder',
      product_type: r.product_type,
      mpn: r.source_model,
      condition: 'new',
      description: r.description,
      slug: r.slug,
      virtual: true,
    }));
  } catch (e) {
    console.warn('generate_static_pages: could not load virtual_products from Supabase:', e.message);
    return [];
  }
}

/* slug -> [article, ...], for O(1) lookup per product. */
function groupArticlesBySlug(articles) {
  const bySlug = {};
  articles.forEach(a => {
    if (!a.category) return;
    (bySlug[a.category] = bySlug[a.category] || []).push(a);
  });
  return bySlug;
}

/* ============================================================
   Per-product static page: product/<id>.html
   ============================================================ */

/* order = пропозиція «під замовлення» (scripts/backorder.js) - тоді Offer
   описує саме її: свій URL, нижча ціна, BackOrder/PreOrder і дата
   надходження, а sku = id цього варіанта у feed.xml (<id>-order). */
function buildJsonLd(p, order = null) {
  const images = [p.image_link, ...(p.additional_images || [])].filter(Boolean).map(absoluteUrl);
  const num = order ? order.price : parseFloat(p.price);
  const ld = {
    '@context': 'https://schema.org/',
    '@type': 'Product',
    name: p.title,
    image: images,
    description: cleanDescription(p.description) || p.title,
    sku: order ? order.id : p.id,
    ...(p.mpn ? { mpn: p.mpn } : {}),
    ...(detectBrand(p.title) ? { brand: { '@type': 'Brand', name: detectBrand(p.title) } } : {}),
    offers: {
      '@type': 'Offer',
      url: order ? orderUrl(p) : productUrl(p),
      priceCurrency: isNaN(num) ? undefined : (order ? order.currency : priceCurrency(p.price)),
      price: isNaN(num) ? undefined : num.toFixed(2),
      availability: order
        ? (order.status === 'preorder' ? 'https://schema.org/PreOrder' : 'https://schema.org/BackOrder')
        : p.availability === 'in_stock'
        ? 'https://schema.org/InStock'
        : p.availability === 'backorder'
        ? 'https://schema.org/BackOrder'
        : 'https://schema.org/OutOfStock',
      ...(order ? { availabilityStarts: order.isoDate } : {}),
      itemCondition: p.condition === 'new' ? 'https://schema.org/NewCondition' : 'https://schema.org/UsedCondition',
      hasMerchantReturnPolicy: {
        '@type': 'MerchantReturnPolicy',
        applicableCountry: 'UA',
        returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
        merchantReturnDays: 14,
        returnMethod: 'https://schema.org/ReturnByMail',
        returnFees: 'https://schema.org/ReturnShippingFees',
      },
    },
  };
  // Prevent "</script>" inside data from closing the tag early.
  return JSON.stringify(ld, null, 2).replace(/<\//g, '<\\/');
}

/* Mirrors the visible breadcrumb nav on product/<id>.html: Головна / Каталог / <title> */
function buildBreadcrumbJsonLd(p) {
  const ld = {
    '@context': 'https://schema.org/',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Головна', item: `${SITE_URL}/` },
      { '@type': 'ListItem', position: 2, name: 'Каталог', item: `${SITE_URL}/catalog.html` },
      { '@type': 'ListItem', position: 3, name: p.title, item: productUrl(p) },
    ],
  };
  return JSON.stringify(ld, null, 2).replace(/<\//g, '<\\/');
}

/* Rewrite root-relative href/src to climb back to the site root — pages now
   live two levels deep, at /product/<slug>/<id>.html, so prefix is '../../'
   (kept as a param, not hardcoded, so it stays correct if depth ever changes
   again). */
function rewriteRelativePaths(html, prefix = '../../') {
  return html.replace(/(href|src)="([^"]*)"/g, (match, attr, url) => {
    if (!url || /^(https?:|mailto:|tel:|#|\.\.\/|\/)/.test(url)) return match;
    return `${attr}="${prefix}${url}"`;
  });
}

/* "Читайте також" — 1-2 article links matching this product's category,
   inserted right before </main> (same anchor point catalog pages use for
   category-description). Renders nothing if there's no matching article. */
function buildRelatedArticlesBlock(p, articlesBySlug) {
  const slug = CATEGORY_TO_SLUG[p.product_type];
  const matches = (slug && articlesBySlug[slug]) || [];
  if (matches.length === 0) return '';

  const items = matches.slice(0, 2).map(a =>
    `          <li><a href="articles/${escapeHtml(a.id)}.html">${escapeHtml(a.title)}</a></li>`
  ).join('\n');

  return `\n    <section class="related-articles">\n      <div class="container">\n` +
    `        <h2 class="related-articles__title" data-i18n="product.related_articles_title">Читайте також</h2>\n` +
    `        <ul class="related-articles__list">\n${items}\n        </ul>\n` +
    `      </div>\n    </section>\n  </main>`;
}

/* Datasheet buttons, rendered into the static page (same labels as
   assets/js/product.js). In the template they sit hidden with href="#" until
   JS fills them in - crawlers (Google/Merchant) saw a "#" link. Now: a real
   file -> real href, visible; no file -> the block is dropped entirely. */
function truncateLabel(text, max) {
  if (!text) return '';
  text = text.trim();
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > max * 0.6) cut = cut.slice(0, lastSpace);
  return cut.trim().replace(/[,;:.\s]+$/, '') + '…';
}

function datasheetExists(link) {
  if (!link) return false;
  if (/^https?:\/\//.test(link)) return true;
  return fs.existsSync(path.join(__dirname, '..', link.replace(/^\//, '')));
}

function renderDatasheetButtons(html, p) {
  const isKit = !!(p.link && p.link2 && /Комплект/i.test(p.product_type || ''));
  const parts = isKit
    ? (p.title || '').replace(/^Комплект автономного енергоживлення:\s*/i, '')
        .split(/\s*\+\s*/).map(s => s.trim().replace(/,\s*$/, ''))
    : [];
  const [invModel, batModel] = parts.length === 2 ? parts : [null, null];

  const buttons = [
    { wrap: 'product-datasheet-wrap', btn: 'btn-datasheet', link: p.link,
      label: isKit
        ? '↓ Даташит для інвертора' + (invModel ? ': ' + truncateLabel(invModel, 45) : '')
        : (/manual/i.test(p.link) ? '↓ Скачати інструкцію для ' : '↓ Скачати даташит для ') + truncateLabel(p.title || 'товару', 55) },
    { wrap: 'product-datasheet-wrap-2', btn: 'btn-datasheet-2', link: p.link2,
      label: '↓ Даташит для акумулятора' + (batModel ? ': ' + truncateLabel(batModel, 45) : '') },
  ];
  for (const b of buttons) {
    const re = new RegExp(`\\s*<div id="${b.wrap}" class="hidden"([^>]*)>\\s*<a id="${b.btn}" href="#"([^>]*?) data-i18n="[^"]*">[\\s\\S]*?</a>\\s*</div>`);
    html = html.replace(re, (m, wrapAttrs, aAttrs) => datasheetExists(b.link)
      ? `\n                <div id="${b.wrap}"${wrapAttrs}>\n                  <a id="${b.btn}" href="${escapeHtml(b.link)}"${aAttrs}>${escapeHtml(b.label)}</a>\n                </div>`
      : '');
  }
  return html;
}

function offerPriceStr(order) {
  return formatPrice(`${order.price} ${order.currency}`);
}

/* Перехресні посилання між варіантами «в наявності» / «під замовлення».
   Ціни й дата - з тих самих даних, що й основна ціна сторінки. Посилання
   відносні в межах тієї ж папки /product/<slug>/, тому блок вставляється
   вже після rewriteRelativePaths(). */
function buildOfferAltBlock(p, order, variant) {
  if (variant === 'order') {
    const statusText = order.status === 'preorder' ? 'Передзамовлення' : 'Під замовлення';
    return `
              <div class="product-offer-note">
                <strong>${statusText}</strong> · Очікується до ${escapeHtml(order.dateLabel)} (до ${order.leadDays} днів)
              </div>
              <div class="product-offer-alt">
                Потрібно швидше? <a href="${escapeHtml(encodeURIComponent(p.id))}.html">Є в наявності за ${escapeHtml(formatPrice(p.price || ''))}</a>
              </div>
`;
  }
  return `
              <div class="product-offer-alt">
                Можна дешевше під замовлення — <a href="${escapeHtml(orderPageFile(p))}">${escapeHtml(offerPriceStr(order))}</a>, доставка до ${escapeHtml(order.dateLabel)}
              </div>
`;
}

/* variant: 'stock' (основна сторінка) або 'order' (сторінка «під замовлення»,
   тоді order обовʼязковий). order на основній сторінці - лише для посилання
   «можна дешевше під замовлення». */
function generateProductPage(p, template, articlesBySlug, order = null, variant = 'stock') {
  const isOrder     = variant === 'order' && !!order;
  const title       = p.title || '';
  const isVirtual   = !!p.virtual;
  const priceStr    = isVirtual ? 'Ціну уточнюйте' : (isOrder ? offerPriceStr(order) : formatPrice(p.price || ''));
  const inStock     = !isVirtual && !isOrder && p.availability === 'in_stock';
  const badgeClass  = isOrder ? 'badge-orange' : isVirtual ? 'badge-grey' : (inStock ? 'badge-green' : 'badge-grey');
  const badgeText   = isOrder
    ? (order.status === 'preorder' ? 'Передзамовлення' : 'Під замовлення')
    : isVirtual ? 'Під замовлення' : (inStock ? '✓ В наявності' : 'Немає в наявності');
  const pageTitle   = isOrder ? `${title} (під замовлення)` : title;
  const cartId      = isOrder ? order.id : p.id;
  const cartTitle   = isOrder
    ? `${title} (${order.status === 'preorder' ? 'передзамовлення' : 'під замовлення'}, очікується до ${order.dateLabel})`
    : title;
  const cartPrice   = isOrder ? order.price : parseFloat(p.price);
  const cartCurrency = isOrder ? order.currency : priceCurrency(p.price);
  const image       = absoluteUrl(p.image_link);
  const metaDesc    = truncate(cleanDescription(p.description) || title, 160);
  const descText    = escapeHtml(cleanDescription(p.description) || '');
  const catLabel    = categoryLabel(p.product_type);
  const mpn         = p.mpn || '-';
  const canonical   = productUrl(p);
  const jsonLd      = buildJsonLd(p, isOrder ? order : null);
  const breadcrumbLd = buildBreadcrumbJsonLd(p);

  let html = template;

  html = html.replace(
    '<title>Товар - Автономка</title>',
    `<title>${escapeHtml(pageTitle)} - Автономка</title>`
  );
  html = html.replace(
    '<meta name="description" content="Детальна інформація про товар в магазині Автономка.">',
    `<meta name="description" content="${escapeHtml(metaDesc)}">`
  );
  html = html.replace(
    '<meta property="og:title" content="Автономка - товар">',
    `<meta property="og:title" content="${escapeHtml(pageTitle)} - Автономка">`
  );
  html = html.replace(
    '<meta property="og:image" content="assets/images/sticker.webp">',
    `<meta property="og:image" content="${escapeHtml(image)}">`
  );
  html = html.replace(
    '<link rel="canonical" href="https://avtonomka.com.ua/product.html">',
    `<link rel="canonical" href="${escapeHtml(canonical)}">`
  );
  html = html.replace(
    '</head>',
    `  <script type="application/ld+json">\n${jsonLd}\n  </script>\n` +
    `  <script type="application/ld+json">\n${breadcrumbLd}\n  </script>\n</head>`
  );
  html = html.replace(
    '<span id="bc-name" data-i18n="product.breadcrumb_item">Товар</span>',
    `<span id="bc-name">${escapeHtml(title)}</span>`
  );
  /* A static product page always represents one real, known product, so the
     loading/not-found/error states can never fire here — strip them from the
     markup entirely (not just hide via CSS) instead of leaving dead text
     content for non-JS crawlers to read. */
  html = html.replace(
    `        <!-- Loading -->
        <div id="loading-state" class="loading-state">
          <div class="spinner"></div>
          <span data-i18n="product.loading">Завантаження товару…</span>
        </div>

`,
    ''
  );
  html = html.replace(
    `        <!-- Not found -->
        <div id="not-found-state" class="empty-state hidden">
          <img src="assets/images/1111111.webp" alt="" loading="lazy">
          <h3 data-i18n="product.not_found_title">Товар не знайдено</h3>
          <p data-i18n="product.not_found_text">Можливо, товар більше не існує або посилання невірне.</p>
          <a href="catalog.html" class="btn btn-primary" data-i18n="product.not_found_btn">Повернутись до каталогу</a>
        </div>

`,
    ''
  );
  html = html.replace(
    `        <!-- Error -->
        <div id="error-state" class="empty-state hidden">
          <img src="assets/images/sticker.webp" alt="" loading="lazy">
          <h3 data-i18n="product.error_title">Помилка завантаження</h3>
          <p data-i18n="product.error_text">Не вдалося завантажити інформацію про товар. Спробуйте пізніше.</p>
          <a href="catalog.html" class="btn btn-outline" data-i18n="product.error_btn">До каталогу</a>
        </div>

`,
    ''
  );
  /* data-variant / data-offer-* читає assets/js/product.js, щоб після
     завантаження products.json не перемалювати ціну «під замовлення»
     ціною «в наявності». */
  html = html.replace(
    '<div id="product-content" class="hidden">',
    isOrder
      ? `<div id="product-content" data-variant="order" data-offer-id="${escapeHtml(order.id)}" ` +
        `data-offer-price="${order.price.toFixed(2)}" data-offer-currency="${escapeHtml(order.currency)}" ` +
        `data-offer-status="${order.status}" data-offer-date-label="${escapeHtml(order.dateLabel)}">`
      : '<div id="product-content">'
  );
  html = html.replace(
    '<img id="gallery-main-img" src="" alt="">',
    `<img id="gallery-main-img" src="${escapeHtml(image)}" alt="${escapeHtml(title)}">`
  );
  html = html.replace(
    '<span id="product-availability" class="badge"></span>',
    `<span id="product-availability" class="badge ${badgeClass}">${escapeHtml(badgeText)}</span>`
  );
  html = html.replace(
    '<h1 id="product-title" class="product-title"></h1>',
    `<h1 id="product-title" class="product-title">${escapeHtml(title)}</h1>`
  );
  html = html.replace(
    '<div id="product-price" class="product-price"></div>',
    `<div id="product-price" class="product-price">${escapeHtml(priceStr)}</div>`
  );
  if (isVirtual) {
    /* Віртуальний товар: ціна не показується (може розійтися з реальною),
       тож замість "у кошик" - дзвінок менеджеру для уточнення й замовлення. */
    html = html.replace(
      /<button type="button" id="btn-add-cart"[\s\S]*?<\/button>/,
      '<a href="tel:+380987772020" class="btn btn-cart">☎ Замовити — уточнити ціну</a>'
    );
  } else {
    html = html.replace(
      '<button type="button" id="btn-add-cart" class="btn btn-cart" data-add-to-cart data-id="" data-title="" data-price="" data-sku="">',
      `<button type="button" id="btn-add-cart" class="btn btn-cart" data-add-to-cart data-id="${escapeHtml(cartId)}" data-title="${escapeHtml(cartTitle)}" data-price="${isNaN(cartPrice) ? '0' : cartPrice.toFixed(2)}" data-currency="${escapeHtml(cartCurrency)}" data-sku="${escapeHtml(p.mpn || '')}">`
    );
  }
  html = html.replace(
    '<span class="product-meta-row__value" id="product-mpn">-</span>',
    `<span class="product-meta-row__value" id="product-mpn">${escapeHtml(mpn)}</span>`
  );
  html = html.replace(
    '<span class="product-meta-row__value" id="product-cat">-</span>',
    `<span class="product-meta-row__value" id="product-cat">${escapeHtml(catLabel || '-')}</span>`
  );
  html = html.replace(
    '<div id="product-desc" class="product-desc"></div>',
    `<div id="product-desc" class="product-desc">${descText}</div>`
  );

  html = renderDatasheetButtons(html, p);

  const relatedArticles = buildRelatedArticlesBlock(p, articlesBySlug);
  if (relatedArticles) {
    html = html.replace('</main>', relatedArticles);
  }

  html = rewriteRelativePaths(html);

  if (order && !isVirtual) {
    html = html.replace(
      '              <div class="product-info__meta">',
      buildOfferAltBlock(p, order, isOrder ? 'order' : 'stock') + '\n              <div class="product-info__meta">'
    );
  }

  return html;
}

/* Old flat /product/<id>.html — kept as a tiny redirect page (not deleted)
   so bookmarks/indexed links don't 404. The real 301 should come from
   .htaccess; this is the fallback for whenever that isn't in effect
   (unclear how this repo's deploy reaches the LiteSpeed host, or whether it
   carries dotfiles — see .htaccess header comment). */
function buildRedirectStub(newUrl, oldUrl) {
  return `<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <!-- Fallback redirect only — the canonical fix is the .htaccess 301 for
       this same path. This meta-refresh exists in case that rewrite isn't
       actually in effect on the live host. -->
  <meta http-equiv="refresh" content="0; url=${escapeHtml(newUrl)}">
  <link rel="canonical" href="${escapeHtml(newUrl)}">
  <title>Redirecting…</title>
</head>
<body>
  <p>Ця сторінка переїхала: <a href="${escapeHtml(newUrl)}">${escapeHtml(newUrl)}</a></p>
</body>
</html>
`;
}

/* Віртуальний товар, у якого з'явився справжній двійник у products.json
   (той самий id без префікса V). Постачальник періодично прибирає й повертає
   товари, тож при імпорті virtual_products 2026-09-02 частина реальних
   товарів якраз була відсутня у фіді й потрапила у віртуальні. Сторінку
   такого V-товару не генеруємо (дубль зі старою ціною), а його URL-и
   301-редиректимо на справжню сторінку. */
function splitShadowedVirtual(products, virtualProducts) {
  const realById = new Map(products.map(p => [String(p.id), p]));
  const kept = [];
  const redirects = []; // { from: 'product/...html', to: absolute URL }
  virtualProducts.forEach(v => {
    const real = realById.get(String(v.id).replace(/^V/, ''));
    if (!real) { kept.push(v); return; }
    const to = productUrl(real);
    redirects.push({ from: `product/${productSlug(v)}/${v.id}.html`, to });
    redirects.push({ from: `product/${v.id}.html`, to });
  });
  return { kept, redirects };
}

/* ============================================================
   Знятий товар -> куди вести його стару адресу. Категорію визначаємо
   за <title> сторінки, яку зараз видаляємо (product_type там уже немає).
   ============================================================ */

const TITLE_TO_CATEGORY = [
  ['комплект', 'komplekty'],
  ['систем', 'systemy-zberihannya'],
  ['2 в 1', 'systemy-zberihannya'],
  ['wi-fi модул', 'wifi-moduli'],
  ['зарядна станція', 'dzherela-zhyvlennya'],
  ['безперебій', 'dzherela-zhyvlennya'],
  ['інвертор', 'hybridni-invertory'],
  ['дбж', 'akumulyatory-dbzh'],
  ['акумул', 'akumulyatory'],
  ['кабел', 'kabeli'],
  ['накінечн', 'kabeli'],
];

function removedPageTarget(html) {
  const m = /<title>([^<]*)<\/title>/.exec(html || '');
  const title = (m ? m[1] : '').toLowerCase();
  const hit = TITLE_TO_CATEGORY.find(([kw]) => title.includes(kw));
  return hit ? `catalog/${hit[1]}.html` : 'catalog.html';
}

function loadRemovedRedirects() {
  try { return JSON.parse(fs.readFileSync(REMOVED_REDIRECTS_FILE, 'utf8')); } catch (e) { return {}; }
}

function saveRemovedRedirects(map) {
  const sorted = {};
  Object.keys(map).sort().forEach(k => { sorted[k] = map[k]; });
  fs.writeFileSync(REMOVED_REDIRECTS_FILE, JSON.stringify(sorted, null, 1) + '\n', 'utf8');
}

async function generateAllProductPages(products, redirects = []) {
  const template = fs.readFileSync(path.join(ROOT, 'product.html'), 'utf8');
  const outDir   = path.join(ROOT, 'product');
  fs.mkdirSync(outDir, { recursive: true });

  const articlesBySlug = groupArticlesBySlug(await loadArticles());
  const lastmod  = {}; // id -> YYYY-MM-DD, for sitemap.xml

  const validRelPaths  = new Set(); // 'slug/id.html' — current nested pages
  const validStubNames = new Set(); // 'id.html' — current legacy stubs
  let orderPages = 0;

  products.forEach(p => {
    const slug = productSlug(p);
    const dir  = path.join(outDir, slug);
    fs.mkdirSync(dir, { recursive: true });

    const order    = getBackorderOffer(p);
    const html     = generateProductPage(p, template, articlesBySlug, order, 'stock');
    const filePath = path.join(dir, `${p.id}.html`);
    const relPath  = path.join('product', slug, `${p.id}.html`);
    const before   = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
    const changed  = before !== html;
    fs.writeFileSync(filePath, html, 'utf8');
    lastmod[p.id] = lastmodFor(relPath, changed);
    validRelPaths.add(path.join(slug, `${p.id}.html`));

    /* Варіант «під замовлення» - окремий URL з canonical на основну сторінку
       (canonical береться з productUrl(p) у generateProductPage). У sitemap
       навмисно НЕ додається. Зникне з backorder_offers.json - файл
       видалить прибирання нижче. */
    if (order) {
      const orderFile = decodeURIComponent(orderPageFile(p));
      fs.writeFileSync(path.join(dir, orderFile),
        generateProductPage(p, template, articlesBySlug, order, 'order'), 'utf8');
      validRelPaths.add(path.join(slug, orderFile));
      orderPages++;
    }

    const stubPath = path.join(outDir, `${p.id}.html`);
    fs.writeFileSync(stubPath, buildRedirectStub(productUrl(p), legacyProductUrl(p)), 'utf8');
    validStubNames.add(`${p.id}.html`);
  });

  /* Редирект-заглушки на місці віртуальних дублів (див. splitShadowedVirtual) -
     фолбек до 301 з .htaccess, як і legacy-заглушки вище. */
  redirects.forEach(r => {
    const rel = r.from.replace(/^product\//, '');
    fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(outDir, rel), buildRedirectStub(r.to), 'utf8');
    if (rel.includes('/')) validRelPaths.add(rel); else validStubNames.add(rel);
  });

  /* Remove pages/stubs for products that dropped out of products.json
     entirely (discontinued) — otherwise they'd sit at their old URL forever
     with stale price/availability, which is exactly the risk this whole
     exercise is meant to avoid. The old URL is recorded in
     data/removed_product_redirects.json and gets a 301 to its category
     (updateHtaccess) instead of a 404 in Search Console. */
  let removed = 0;
  const removedRedirects = loadRemovedRedirects();
  const forget = (rel, file) => {
    // Стару адресу ведемо в категорію (301 у .htaccess), а не в 404.
    const key = 'product/' + rel.split(path.sep).join('/');
    if (!removedRedirects[key]) removedRedirects[key] = removedPageTarget(fs.readFileSync(file, 'utf8'));
    fs.unlinkSync(file);
    removed++;
  };
  fs.readdirSync(outDir, { withFileTypes: true }).forEach(entry => {
    if (entry.isDirectory()) {
      const slugDir = path.join(outDir, entry.name);
      fs.readdirSync(slugDir).forEach(file => {
        if (!validRelPaths.has(path.join(entry.name, file))) {
          forget(path.join(entry.name, file), path.join(slugDir, file));
        }
      });
      if (fs.readdirSync(slugDir).length === 0) fs.rmdirSync(slugDir);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      if (!validStubNames.has(entry.name)) {
        forget(entry.name, path.join(outDir, entry.name));
      }
    }
  });
  saveRemovedRedirects(removedRedirects);

  console.log(`generate_static_pages: wrote ${products.length} product pages to /product/<slug>/<id>.html ` +
    `+ ${products.length} legacy redirect stubs` +
    (orderPages ? ` + ${orderPages} «під замовлення» page(s)` : '') +
    (redirects.length ? ` + ${redirects.length} redirect(s) for virtual duplicates` : '') +
    (removed ? `, removed ${removed} stale file(s) for discontinued products` : ''));

  return lastmod;
}

/* ============================================================
   Catalog listing prerender — first page, default sort (name_asc),
   no filters. Exactly what catalog.js renders on first load, so
   the JS re-render on top is a no-op visually.
   ============================================================ */

function renderCard(p, base) {
  const inStock  = p.availability === 'in_stock';
  const availabilityText = inStock ? '✓ В наявності' : 'Немає';
  const priceStr = formatPrice(p.price || '');
  const title    = truncate(p.title || '', 80);
  const img      = p.image_link ? (/^https?:\/\//.test(p.image_link) ? p.image_link : base + p.image_link) : (base + 'assets/images/zaglushka.png');
  const zagl     = base + 'assets/images/zaglushka.png';
  const href     = `${base}product/${productSlug(p)}/${encodeURIComponent(p.id)}.html`;

  const topBadgeHtml = isTopProduct(p.id) ? `<span class="product-card__pill product-card__pill--top">🔥 ТОП</span>` : '';

  const isKit = CATEGORY_TO_SLUG[p.product_type] === 'komplekty';
  let stackExtraHtml = '';
  if (isKit) {
    let monobrandBadgeHtml = '';
    let tierBadgeHtml = '';
    const [invBrand, batBrand] = kitBrandParts(p.title);
    if (invBrand && invBrand === batBrand) {
      monobrandBadgeHtml = `<span class="product-card__pill product-card__pill--monobrand">Один бренд ${escapeHtml(invBrand)}</span>`;
    }
    const tier = kitStatusTier(p.title);
    if (tier) {
      tierBadgeHtml = `<span class="product-card__pill product-card__pill--tier-${tier}">${escapeHtml(TIER_LABELS[tier])}</span>`;
    }
    stackExtraHtml = `${tierBadgeHtml}${monobrandBadgeHtml}`;
  }

  let cableSpecsHtml = '';
  if (CATEGORY_TO_SLUG[p.product_type] === 'kabeli') {
    const cs = extractCrossSection(p.title);
    if (cs) cableSpecsHtml += `<span class="product-card__pill product-card__pill--spec">⌀ ${escapeHtml(cs)}</span>`;
    const ls = extractLugSize(p.title);
    if (ls) cableSpecsHtml += `<span class="product-card__pill product-card__pill--spec">🔩 ${escapeHtml(ls)}</span>`;
    const len = extractLength(p.title);
    if (len) cableSpecsHtml += `<span class="product-card__pill product-card__pill--spec">📏 ${escapeHtml(len)}</span>`;
  }

  return `
  <div class="product-card">
    <a href="${href}" class="product-card__img-wrap" aria-label="${escapeHtml(title)}">
      <img src="${escapeHtml(img)}"
           alt="${escapeHtml(p.title || '')}"
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
        ${p.mpn ? `<span class="product-card__sku">Арт. ${escapeHtml(p.mpn)}</span>` : ''}
      </div>
    </div>
    <div class="product-card__footer">
      <a href="${href}" class="btn btn-block">Детальніше →</a>
      <button type="button" class="btn btn-cart btn-block" data-add-to-cart
              data-id="${escapeHtml(p.id)}" data-title="${escapeHtml(p.title || '')}"
              data-price="${isNaN(parseFloat(p.price)) ? '0' : parseFloat(p.price).toFixed(2)}"
              data-currency="${escapeHtml(priceCurrency(p.price))}" data-sku="${escapeHtml(p.mpn || '')}">
        🛒 Додати в кошик
      </button>
      <a href="${base}return-policy.html#return" class="product-card__return-link">Умови повернення</a>
    </div>
  </div>`;
}

function defaultFirstPage(products) {
  const sorted = [...products].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  return sorted.slice(0, ITEMS_PER_PAGE);
}

const SSR_START = '<!-- SSR:START -->';
const SSR_END   = '<!-- SSR:END -->';

function injectGrid(filePath, cardsHtml) {
  const before = fs.readFileSync(filePath, 'utf8');
  const block = `${SSR_START}\n${cardsHtml}\n            ${SSR_END}`;
  const markerRe = new RegExp(SSR_START + '[\\s\\S]*?' + SSR_END);

  let html;
  if (markerRe.test(before)) {
    html = before.replace(markerRe, block);
  } else {
    html = before.replace(
      '<div id="products-grid" class="products-grid"></div>',
      `<div id="products-grid" class="products-grid">${block}</div>`
    );
  }

  fs.writeFileSync(filePath, html, 'utf8');
  return before !== html;
}

/* SEO text block under the product grid on each catalog/<slug>.html —
   150-250 word, human-written, category-specific descriptions kept in
   data/category_descriptions.json so they're easy to edit without
   touching this script. Never invented here: if a slug has no entry,
   the page simply gets no description block. */
const CATDESC_START = '<!-- CATDESC:START -->';
const CATDESC_END   = '<!-- CATDESC:END -->';

function loadCategoryDescriptions() {
  const file = path.join(ROOT, 'data', 'category_descriptions.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn('generate_static_pages: could not parse data/category_descriptions.json:', e.message);
    return {};
  }
}

function injectCategoryDescription(filePath, text) {
  const before = fs.readFileSync(filePath, 'utf8');
  if (!text) return false;

  const paragraphs = text.split(/\n{2,}/).map(p => `        <p>${escapeHtml(p.trim())}</p>`).join('\n');
  const section = `\n    <section class="category-description">\n      <div class="container">\n` +
    `${CATDESC_START}\n${paragraphs}\n        ${CATDESC_END}\n      </div>\n    </section>\n  </main>`;
  const markerRe = new RegExp(
    '\\n\\s*<section class="category-description">[\\s\\S]*?' + CATDESC_START +
    '[\\s\\S]*?' + CATDESC_END + '[\\s\\S]*?</section>\\n\\s*</main>'
  );

  let html;
  if (markerRe.test(before)) {
    html = before.replace(markerRe, section);
  } else {
    html = before.replace(/\n\s*<\/main>/, section);
  }

  fs.writeFileSync(filePath, html, 'utf8');
  return before !== html;
}

function generateCatalogGrids(products) {
  const lastmod = {}; // relative path -> YYYY-MM-DD, for sitemap.xml
  const descriptions = loadCategoryDescriptions();

  const rootPage = defaultFirstPage(products);
  const rootChanged = injectGrid(
    path.join(ROOT, 'catalog.html'),
    rootPage.map(p => renderCard(p, '')).join('\n')
  );
  lastmod['catalog.html'] = lastmodFor('catalog.html', rootChanged);

  Object.keys(SLUG_TO_CATEGORY).forEach(slug => {
    const cat      = SLUG_TO_CATEGORY[slug];
    const filtered = products.filter(p => p.product_type === cat);
    const page     = defaultFirstPage(filtered);
    const relPath  = path.join('catalog', `${slug}.html`);
    const file     = path.join(ROOT, relPath);
    const gridChanged = injectGrid(file, page.map(p => renderCard(p, '../')).join('\n'));
    const descChanged = injectCategoryDescription(file, descriptions[slug]);
    lastmod[slug]  = lastmodFor(relPath, gridChanged || descChanged);
  });

  console.log(`generate_static_pages: prerendered catalog.html + ${Object.keys(SLUG_TO_CATEGORY).length} catalog/*.html grids`);
  return lastmod;
}

/* ============================================================
   sitemap.xml — regenerate the "Товари" section with the new
   /product/<id>.html URLs (previously stale/partial, old ?id= scheme).
   ============================================================ */

/* Static, hand-maintained pages — not touched by this script, so their
   lastmod comes straight from git history (whenever a human last edited
   the file). relPath === '' means the homepage (index.html on disk, but
   served at the site root). */
const STATIC_PAGES = [
  { relPath: '',                      changefreq: 'weekly',  priority: '1.0' },
  { relPath: 'catalog.html',          changefreq: 'daily',   priority: '0.9' },
  { relPath: 'articles.html',         changefreq: 'weekly',  priority: '0.7' },
  { relPath: 'blog.html',             changefreq: 'weekly',  priority: '0.7' },
  { relPath: 'privacy.html',          changefreq: 'monthly', priority: '0.3' },
  { relPath: 'terms.html',            changefreq: 'monthly', priority: '0.3' },
  { relPath: 'about.html',            changefreq: 'monthly', priority: '0.5' },
  { relPath: 'delivery-payment.html', changefreq: 'monthly', priority: '0.4' },
  { relPath: 'spivpratsia.html',      changefreq: 'monthly', priority: '0.5' },
  { relPath: 'return-policy.html',    changefreq: 'monthly', priority: '0.4' },
  { relPath: 'warranty.html',         changefreq: 'monthly', priority: '0.4' },
];

function urlEntry(loc, lastmod, changefreq, priority) {
  return `  <url>
    <loc>${loc}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
}

/* Rebuilds the whole file from the current products.json + catalog.html/
   catalog/*.html state, instead of only ever refreshing the "Товари"
   section — so static and category URLs, and each one's <lastmod>, stay
   in sync automatically too. catalog.html itself (root grid, not a
   /catalog/<slug> category page) is listed under STATIC_PAGES already. */
function updateSitemap(products, catalogLastmod, productLastmod, articleLastmod = {}) {
  const file = path.join(ROOT, 'sitemap.xml');

  const staticEntries = STATIC_PAGES.map(({ relPath, changefreq, priority }) => {
    const loc = relPath ? `${SITE_URL}/${relPath}` : `${SITE_URL}/`;
    const fsPath = relPath || 'index.html';
    return urlEntry(loc, lastmodFor(fsPath, false), changefreq, priority);
  }).join('\n');

  const categoryEntries = Object.keys(SLUG_TO_CATEGORY).map(slug => {
    const loc = `${SITE_URL}/catalog/${slug}.html`;
    return urlEntry(loc, catalogLastmod[slug] || TODAY, 'weekly', '0.8');
  }).join('\n');

  const productEntries = products.map(p =>
    urlEntry(productUrl(p), productLastmod[p.id] || TODAY, 'weekly', '0.6')
  ).join('\n');

  const articleEntries = Object.keys(articleLastmod).map(id =>
    urlEntry(articleUrl({ id }), articleLastmod[id], 'monthly', '0.6')
  ).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">

  <!-- Статичні сторінки -->
${staticEntries}

  <!-- Категорії каталогу -->
${categoryEntries}

  <!-- Статті -->
${articleEntries}

  <!-- Товари -->
${productEntries}

</urlset>
`;

  fs.writeFileSync(file, xml, 'utf8');
  console.log(`generate_static_pages: sitemap.xml rebuilt — ${STATIC_PAGES.length} static + ` +
    `${Object.keys(SLUG_TO_CATEGORY).length} category + ${products.length} product + ` +
    `${Object.keys(articleLastmod).length} article URLs`);
}

/* ============================================================
   .htaccess — one explicit 301 per product id, old flat URL -> new
   /product/<slug>/<id>.html. Regenerated from scratch every run so it
   never drifts from products.json (same approach as sitemap.xml). A slug
   can't be derived by a single regex rule (it's a per-product lookup), so
   this is 80 explicit RewriteRules rather than one generic pattern.
   Requires mod_rewrite — confirmed avtonomka.com.ua responds as
   LiteSpeed/CyberPanel, which honors .htaccess mod_rewrite syntax. This is
   the primary redirect mechanism; the per-product stub page written by
   generateAllProductPages() is the fallback if this file somehow isn't
   picked up by whatever deploys this repo to that host.
   ============================================================ */

function updateHtaccess(products, redirects = []) {
  const file = path.join(ROOT, '.htaccess');
  const rule = (from, to) =>
    `RewriteRule ^${from.replace(/\./g, '\\.')}$ ${SITE_URL}/${to.replace(SITE_URL + '/', '')} [R=301,L]`;
  const live = products.map(p => rule(`product/${p.id}.html`, `product/${productSlug(p)}/${p.id}.html`))
    .concat(redirects.map(r => rule(r.from, r.to)));

  /* Знятi товари: пропускаємо адреси, де знову є сторінка (товар повернувся),
     а ціль, якої вже немає (товар зняли вдруге), замінюємо на каталог. */
  const taken = new Set(products.map(p => `product/${p.id}.html`).concat(redirects.map(r => r.from)));
  const gone = Object.entries(loadRemovedRedirects())
    .filter(([from]) => !taken.has(from) && !fs.existsSync(path.join(ROOT, from)))
    .map(([from, to]) => rule(from, fs.existsSync(path.join(ROOT, to)) ? to : 'catalog.html'));
  const rules = live.concat(gone).join('\n');

  const content = `# Auto-generated by scripts/generate_static_pages.js — do not edit by hand.
# Redirects old /product/<id>.html URLs to the new /product/<slug>/<id>.html
# format, and URLs of removed products to their category, so existing Google
# indexing and external links keep working.
<IfModule mod_rewrite.c>
RewriteEngine On

${rules}
</IfModule>
`;

  fs.writeFileSync(file, content, 'utf8');
  console.log(`generate_static_pages: .htaccess rebuilt — ${live.length} redirect rule(s) + ${gone.length} for removed products`);
}

/* ============================================================
   Telegram feed + articles list — mirrors assets/js/blog.js's
   renderPostFull() and assets/js/articles.js's renderCard() exactly, so
   the baked HTML matches what the client JS re-renders on top of it.
   ============================================================ */

function loadJson(relPath) {
  const file = path.join(ROOT, relPath);
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn(`generate_static_pages: could not parse ${relPath}:`, e.message);
    return [];
  }
}

function formatDateUk(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });
}

/* Verbatim structure of blog.js:renderPostFull() */
function renderTelegramPostFull(post) {
  const dateStr = formatDateUk(post.date);
  const imgHtml = post.photo
    ? `<div class="tg-post__img"><img src="${escapeHtml(post.photo)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
    : '';
  return `
  <article class="tg-post">
    <div class="tg-post__header">
      <img src="assets/images/logo.jpg" alt="Автономка" class="tg-post__avatar">
      <div class="tg-post__meta">
        <span class="tg-post__channel">Автономка</span>
        ${dateStr ? `<span class="tg-post__date">${escapeHtml(dateStr)}</span>` : ''}
      </div>
    </div>
    ${imgHtml}
    ${post.text ? `<div class="tg-post__text">${escapeHtml(post.text)}</div>` : ''}
    <div class="tg-post__footer">
      <a href="${escapeHtml(post.url || 'https://telegram.me/avtonomka_od')}"
         target="_blank" rel="noopener noreferrer"
         class="tg-post__link">Переглянути в Telegram →</a>
    </div>
  </article>`;
}

/* Verbatim structure of articles.js:renderCard() */
function renderArticleCard(article) {
  const dateStr = formatDateUk(article.date);
  const title   = article.title || '';
  const summary = article.summary || '';
  const imgHtml = article.photo
    ? `<div class="article-card__img"><img src="${escapeHtml(article.photo)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
    : '<div class="article-card__img article-card__img--placeholder"></div>';
  const metaParts = [];
  if (dateStr) metaParts.push(escapeHtml(dateStr));
  metaParts.push(`<span class="article-card__views" data-views-id="${escapeHtml(article.id)}">…</span>`);
  return `
  <article class="article-card" data-id="${escapeHtml(article.id)}" tabindex="0" role="button" aria-label="${escapeHtml(title)}">
    ${imgHtml}
    <div class="article-card__body">
      <div class="article-card__date">${metaParts.join(' · ')}</div>
      <h2 class="article-card__title"><a href="articles/${escapeHtml(article.id)}.html">${escapeHtml(title)}</a></h2>
      ${summary ? `<p class="article-card__summary">${escapeHtml(summary)}</p>` : ''}
    </div>
    <div class="article-card__footer">
      <span class="article-card__link">Читати далі →</span>
    </div>
  </article>`;
}

/* Verbatim structure of index.html's inline "Останні 3 статті" script */
function renderHomeArticleCard(article) {
  const dateStr = formatDateUk(article.date);
  const title   = article.title || '';
  const summary = article.summary || '';
  const imgHtml = article.photo
    ? `<div class="article-card__img"><img src="${escapeHtml(article.photo)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
    : '<div class="article-card__img article-card__img--placeholder"></div>';
  const meta = (dateStr ? escapeHtml(dateStr) + ' · ' : '') + `<span data-views-id="${escapeHtml(article.id)}">…</span>`;
  return `<a href="articles/${escapeHtml(article.id)}.html" class="article-card" style="text-decoration:none">
              ${imgHtml}
              <div class="article-card__body">
                <div class="article-card__date">${meta}</div>
                <h3 class="article-card__title">${escapeHtml(title)}</h3>
                ${summary ? `<p class="article-card__summary">${escapeHtml(summary)}</p>` : ''}
              </div>
              <div class="article-card__footer"><span class="article-card__link">Читати далі →</span></div>
            </a>`;
}

/* ============================================================
   Окрема статична сторінка на кожну статтю: articles/<id>.html.
   Раніше повний текст відкривався тільки JS-ом по articles.html#<id> -
   Google відкидає все після "#", тож для нього всі статті були однією
   сторінкою articles.html без тексту. Тепер у кожної своя адреса,
   <title>/description/canonical, JSON-LD Article і текст прямо в HTML.
   articles.js на цих сторінках лише рахує перегляди (і перемальовує
   текст англійською, якщо обрано EN). Старі articles.html#<id>
   articles.js переводить сюди.
   ============================================================ */

const ARTICLES_DIR = path.join(ROOT, 'articles');

function articleUrl(a) {
  return `${SITE_URL}/articles/${a.id}.html`;
}

/* Те саме, що articles.js:formatInline() - на вже екранованому тексті. */
function formatArticleInline(escapedText) {
  return escapedText
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/* Таблиця: абзац, де кожен рядок "| a | b |"; перший рядок - заголовок,
   рядок-розділювач "|---|---|" пропускається. Те саме, що articles.js:renderTable(). */
function isArticleTable(lines) {
  return lines.length > 1 && lines.every(line => line.startsWith('|'));
}
function renderArticleTable(lines) {
  const rows = lines
    .filter(line => !/^\|[\s:|-]+\|?$/.test(line))
    .map(line => line.replace(/^\||\|$/g, '').split('|').map(c => formatArticleInline(escapeHtml(c.trim()))));
  const head = rows.shift().map(c => `<th>${c}</th>`).join('');
  const body = rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<div class="article-table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/* Verbatim structure of articles.js:renderFull() (back button -> посилання). */
function renderArticleBody(body) {
  return (body || '')
    .split(/\n\n+/)
    .map(para => para.trim())
    .filter(Boolean)
    .map(para => {
      if (para.startsWith('## ')) {
        return `<h2>${formatArticleInline(escapeHtml(para.slice(3).trim()))}</h2>`;
      }
      const lines = para.split('\n');
      if (isArticleTable(lines)) return renderArticleTable(lines);
      if (lines.length > 1 && lines.every(line => line.startsWith('- '))) {
        const items = lines.map(line => `<li>${formatArticleInline(escapeHtml(line.slice(2).trim()))}</li>`).join('');
        return `<ul>${items}</ul>`;
      }
      return `<p>${formatArticleInline(escapeHtml(para)).replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n        ');
}

/* articles.js:relatedProducts() - перші 4 товари категорії статті. */
function renderArticleRelated(article, products) {
  const productType = SLUG_TO_CATEGORY[article.category];
  if (!productType) return '';
  const items = products.filter(p => p.product_type === productType).slice(0, 4);
  if (!items.length) return '';
  const cards = items.map(p => {
    const title = p.title || '';
    const href  = path.posix.join('product', productSlug(p), `${p.id}.html`);
    const img   = p.image_link || 'assets/images/zaglushka.png';
    return `
        <div class="product-card">
          <a href="${escapeHtml(href)}" class="product-card__img-wrap" aria-label="${escapeHtml(title)}">
            <img src="${escapeHtml(img)}" alt="${escapeHtml(title)}" loading="lazy" onerror="this.src='../assets/images/zaglushka.png'">
          </a>
          <div class="product-card__body">
            <a href="${escapeHtml(href)}" class="product-card__title">${escapeHtml(title)}</a>
            <div class="product-card__price-row">
              <span class="product-card__price">${escapeHtml(formatPrice(p.price || ''))}</span>
            </div>
          </div>
        </div>`;
  }).join('');
  return `
      <div class="article-full__related">
        <h2 data-i18n="articles.related_products_title">Схожі товари</h2>
        <div class="products-grid products-grid--compact">${cards}
        </div>
      </div>`;
}

/* «## Часті запитання» (або «## FAQ»), далі абзаци "**Питання?** Відповідь"
   -> [{ q, a }] для FAQPage. Розділ закінчується на наступному ## заголовку. */
function articleFaq(body) {
  const faq = [];
  let inFaq = false;
  for (const para of (body || '').split(/\n\n+/).map(p => p.trim()).filter(Boolean)) {
    if (para.startsWith('## ')) { inFaq = /^##\s+(Часті запитання|FAQ)/i.test(para); continue; }
    const m = inFaq && para.match(/^\*\*([^*]+)\*\*\s*([\s\S]+)$/);
    if (m) faq.push({ q: m[1].trim(), a: m[2].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*/g, '').trim() });
  }
  return faq;
}

function buildArticleJsonLd(a) {
  const faq = articleFaq(a.body);
  const ld = [
    {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: a.title,
      description: a.summary || undefined,
      image: a.photo ? absoluteUrl(a.photo) : undefined,
      datePublished: a.date || undefined,
      dateModified: (a.updated_at || a.date || '').slice(0, 10) || undefined,
      inLanguage: 'uk',
      mainEntityOfPage: articleUrl(a),
      author: { '@type': 'Organization', name: 'Автономка', url: `${SITE_URL}/` },
      publisher: {
        '@type': 'Organization', name: 'Автономка',
        logo: { '@type': 'ImageObject', url: `${SITE_URL}/assets/images/logo.jpg` },
      },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Головна', item: `${SITE_URL}/` },
        { '@type': 'ListItem', position: 2, name: 'Статті', item: `${SITE_URL}/articles.html` },
        { '@type': 'ListItem', position: 3, name: a.title, item: articleUrl(a) },
      ],
    },
  ];
  if (faq.length) {
    ld.push({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faq.map(f => ({
        '@type': 'Question', name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    });
  }
  return ld.map(x =>
    `  <script type="application/ld+json">\n${JSON.stringify(x, null, 2).replace(/<\//g, '<\\/')}\n  </script>`
  ).join('\n');
}

function generateArticlePage(a, template, products) {
  const title   = a.title || '';
  const summary = a.summary || '';
  const desc    = truncate(summary || title, 160);
  const dateStr = formatDateUk(a.date);
  const imgHtml = a.photo
    ? `<div class="article-full__img"><img src="${escapeHtml(a.photo)}" alt="${escapeHtml(title)}" onerror="this.parentElement.style.display='none'"></div>`
    : '';
  const meta = (dateStr ? escapeHtml(dateStr) + ' · ' : '') +
    `<span class="article-full__views" data-views-id="${escapeHtml(a.id)}">…</span>`;

  const content = `<div id="article-detail" data-article-id="${escapeHtml(a.id)}">
  <div class="article-full">
    <a class="article-full__back" href="articles.html" data-i18n="articles.back">← Назад до статей</a>
    ${imgHtml}
    <div class="article-full__content">
      <div class="article-full__date">${meta}</div>
      <h1 class="article-full__title">${escapeHtml(title)}</h1>
      ${summary ? `<p class="article-full__lead">${escapeHtml(summary)}</p>` : ''}
      <div class="article-full__body">
        ${renderArticleBody(a.body)}
      </div>${renderArticleRelated(a, products)}
    </div>
  </div>
        </div>`;

  let html = template;
  const fullTitle = `${title} - Автономка`;
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(fullTitle)}</title>`);
  html = html.replace(/<meta name="description" content="[^"]*">/,
    `<meta name="description" content="${escapeHtml(desc)}">`);
  html = html.replace(/<meta property="og:title" content="[^"]*">/,
    `<meta property="og:type" content="article">\n  <meta property="og:title" content="${escapeHtml(title)}">`);
  html = html.replace(/<meta property="og:description" content="[^"]*">/,
    `<meta property="og:description" content="${escapeHtml(desc)}">\n  <meta property="og:url" content="${articleUrl(a)}">`);
  html = html.replace(/<meta property="og:image" content="[^"]*">/,
    `<meta property="og:image" content="${escapeHtml(a.photo ? absoluteUrl(a.photo) : SITE_URL + '/assets/images/sticker.webp')}">`);
  html = html.replace(/<link rel="canonical" href="[^"]*">/,
    `<link rel="canonical" href="${articleUrl(a)}">\n${buildArticleJsonLd(a)}`);
  // Шапку "Статті" прибираємо - заголовок h1 тут сама стаття.
  html = html.replace(/\s*<!-- PAGE HEADER -->\s*<div class="page-header">[\s\S]*?<\/div>\s*<\/div>/, '');
  html = html.replace(/<div id="articles-list">[\s\S]*?<div id="article-detail" class="hidden"><\/div>/, content);

  return rewriteRelativePaths(html, '../');
}

/* Пише articles/<id>.html для кожної статті й видаляє сторінки статей,
   яких у Supabase вже нема. Повертає { id: lastmod } для sitemap.xml.
   Якщо Supabase не відповів (articles порожній) - файли не чіпаємо, а в
   sitemap ідуть ті сторінки, що вже лежать в articles/. */
function generateArticlePages(articles, products) {
  const lastmod = {};
  if (!articles.length) {
    if (fs.existsSync(ARTICLES_DIR)) {
      fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.html')).forEach(f => {
        lastmod[f.slice(0, -5)] = lastmodFor(path.join('articles', f), false);
      });
    }
    return lastmod;
  }
  const template = fs.readFileSync(path.join(ROOT, 'articles.html'), 'utf8');
  if (!template.includes('<div id="articles-list">')) {
    console.warn('generate_static_pages: articles.html has no #articles-list - article pages skipped');
    return lastmod;
  }
  fs.mkdirSync(ARTICLES_DIR, { recursive: true });

  const keep = new Set();
  articles.forEach(a => {
    if (!a.id || !/^[a-z0-9-]+$/i.test(a.id)) return;
    const file = path.join(ARTICLES_DIR, `${a.id}.html`);
    const html = generateArticlePage(a, template, products);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (before !== html) fs.writeFileSync(file, html, 'utf8');
    keep.add(`${a.id}.html`);
    lastmod[a.id] = lastmodFor(path.join('articles', `${a.id}.html`), before !== html);
  });

  fs.readdirSync(ARTICLES_DIR)
    .filter(f => f.endsWith('.html') && !keep.has(f))
    .forEach(f => fs.unlinkSync(path.join(ARTICLES_DIR, f)));

  console.log(`generate_static_pages: ${keep.size} article pages in articles/`);
  return lastmod;
}

/* Generic idempotent inject: replaces an existing SSR:<tag>:START/END block
   in place, or (first run) the exact original wrapper markup given in
   `firstRunFrom` (the whole `<div id="...">...loading-state...</div>`),
   with `openTag + marker-wrapped html + closeTag` — i.e. the same div,
   now holding the baked cards instead of the loading placeholder. */
function injectMarked(filePath, tag, firstRunFrom, openTag, closeTag, html) {
  const before = fs.readFileSync(filePath, 'utf8');
  const start = `<!-- SSR:${tag}:START -->`;
  const end   = `<!-- SSR:${tag}:END -->`;
  const block = `${start}\n${html}\n${end}`;
  const markerRe = new RegExp(start + '[\\s\\S]*?' + end);

  let after;
  if (markerRe.test(before)) {
    after = before.replace(markerRe, block);
  } else if (before.includes(firstRunFrom)) {
    after = before.replace(firstRunFrom, `${openTag}${block}${closeTag}`);
  } else {
    console.warn(`generate_static_pages: could not find injection point for SSR:${tag} in ${filePath}`);
    return false;
  }

  fs.writeFileSync(filePath, after, 'utf8');
  return before !== after;
}

async function generateTelegramAndArticles() {
  const posts = loadJson(path.join('data', 'telegram_posts.json'));
  const articles = (await loadArticles())
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  injectMarked(
    path.join(ROOT, 'blog.html'),
    'TG',
    '<div id="blog-grid" class="blog-grid-full"></div>',
    '<div id="blog-grid" class="blog-grid-full">', '</div>',
    posts.map(renderTelegramPostFull).join('\n')
  );

  injectMarked(
    path.join(ROOT, 'articles.html'),
    'ARTICLES',
    '<div id="articles-grid" class="articles-grid"></div>',
    '<div id="articles-grid" class="articles-grid">', '</div>',
    articles.map(renderArticleCard).join('\n')
  );

  const homeTgFrom = `<div id="home-tg-feed" class="tg-feed">
              <div class="loading-state">
                <div class="spinner"></div>
                <span data-i18n="home.loading">Завантаження…</span>
              </div>
            </div>`;
  injectMarked(
    path.join(ROOT, 'index.html'),
    'HOME-TG',
    homeTgFrom,
    '<div id="home-tg-feed" class="tg-feed">', '</div>',
    posts.slice(0, 15).map(renderTelegramPostFull).join('\n')
  );

  const homeArticlesFrom = `<div id="home-articles-grid" class="articles-grid">
          <div class="loading-state" style="grid-column:1/-1">
            <div class="spinner"></div>
            <span data-i18n="home.articles_loading">Завантаження статей…</span>
          </div>
        </div>`;
  injectMarked(
    path.join(ROOT, 'index.html'),
    'HOME-ARTICLES',
    homeArticlesFrom,
    '<div id="home-articles-grid" class="articles-grid">', '</div>',
    articles.slice(0, 3).map(renderHomeArticleCard).join('\n')
  );

  console.log(`generate_static_pages: prerendered ${posts.length} Telegram posts + ${articles.length} articles into blog.html/articles.html/index.html`);
}

/* ============================================================ */

(async () => {
  const products = loadProducts();
  const { kept: virtualProducts, redirects } = splitShadowedVirtual(products, await loadVirtualProducts());
  if (redirects.length) {
    console.log(`generate_static_pages: ${redirects.length / 2} virtual product(s) duplicate a real one - redirecting`);
  }
  const allProducts = [...products, ...virtualProducts];
  const productLastmod = await generateAllProductPages(allProducts, redirects);
  // Віртуальні товари навмисно не передаємо в каталог - тільки реальні.
  const catalogLastmod = generateCatalogGrids(products);
  const articles = await loadArticles();
  const articleLastmod = generateArticlePages(articles, products);
  updateSitemap(allProducts, catalogLastmod, productLastmod, articleLastmod);
  updateHtaccess(allProducts, redirects);
  await generateTelegramAndArticles();
})();
