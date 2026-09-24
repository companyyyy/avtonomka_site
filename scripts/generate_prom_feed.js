/**
 * Generates the Prom.ua import file (prom.xml) from products.json, in the
 * Price.ua XML flavour Prom accepts:
 *   https://support.prom.ua/hc/uk/articles/360004963578 (Price.ua differences)
 *   https://support.prom.ua/hc/uk/articles/360004963538 (base XML/YML tags)
 * Served at https://avtonomka.com.ua/prom.xml - Prom pulls it by link.
 * Separate from feed.xml (Google Merchant) on purpose: different format.
 * Run: node scripts/generate_prom_feed.js
 */

const fs   = require('fs');
const path = require('path');
const { slugify } = require('./slugify');

const SITE_URL = 'https://avtonomka.com.ua';

const products = JSON.parse(fs.readFileSync(path.join(__dirname, '../products.json'), 'utf-8'));

/* Prom groups. IDs are fixed so a group keeps its identity in the Prom
   cabinet across imports - never renumber, only append. Same product_type
   strings as SLUG_TO_CATEGORY in assets/js/catalog.js.
   portal = Prom marketplace category id (from Prom's "Список категорій",
   https://my.prom.ua/cabinet/export_categories/xls). Set explicitly so Prom
   doesn't guess - left to itself it put a kit into a spare-parts category
   that requires «Код запчастини». */
const PORTAL = {
  inverters: 5140401,   // Електрообладнання > ... > Перетворювачі > Інвертори
  batteries: 5280501,   // Електрообладнання > Батареї та акумулятори > Акумулятори загального призначення
  ups:       14191106,  // Електрообладнання > ... > Блоки живлення > Джерела безперебійного живлення (дбж)
  cables:    14190408,  // Електрообладнання > ... > Дріт, кабель > Силові кабелі, перемички
  stations:  500901,    // Техніка та електроніка > Повербанки та зарядні станції > Зарядні станції
};
const CATEGORIES = [
  { id: 1, type: 'Автономна енергетика > Гибридні інвертори',                        name: 'Гібридні інвертори',                       portal: PORTAL.inverters },
  { id: 2, type: 'Автономна енергетика > Акумулятори для гібридних інверторів',      name: 'Акумулятори для гібридних інверторів',     portal: PORTAL.batteries },
  { id: 3, type: 'Автономна енергетика > Комплекти автономного енергоживлення',      name: 'Комплекти автономного енергоживлення',     portal: PORTAL.ups },
  { id: 4, type: 'Автономна енергетика > Силові та сонячні кабелі',                  name: 'Силові та сонячні кабелі',                 portal: PORTAL.cables },
  { id: 5, type: 'Обладнання > Джерела безперебійного живлення',                     name: 'Джерела безперебійного живлення',          portal: PORTAL.ups },
  { id: 6, type: 'Акумулятори і батарейки > Акумулятори для ДБЖ',                     name: 'Акумулятори для ДБЖ',                      portal: PORTAL.batteries },
  { id: 7, type: 'Автономна енергетика > Системи зберігання електроенергії 2 в 1',   name: 'Системи зберігання електроенергії 2 в 1',  portal: PORTAL.ups },
];

/* Per-item override of the group's portal category - the ДБЖ group mixes
   mini-UPS units with portable charging stations. */
function portalFor(p, cat) {
  if (/^Зарядна станція/i.test(p.title || '')) return PORTAL.stations;
  return cat.portal;
}
const CATEGORY_BY_TYPE = {};
CATEGORIES.forEach(c => { CATEGORY_BY_TYPE[c.type] = c; });

/* A product_type nobody has added above yet still gets exported, under a
   group derived from its last "A > B" segment, with a stable id from a
   hash of the type (1000+ so it can't collide with the fixed ones). */
function categoryFor(type) {
  if (CATEGORY_BY_TYPE[type]) return CATEGORY_BY_TYPE[type];
  let h = 0;
  for (const ch of String(type || '')) h = (h * 31 + ch.codePointAt(0)) % 900000000;
  const c = { id: 1000 + h, type, name: String(type || 'Інші товари').split('>').pop().trim() || 'Інші товари' };
  CATEGORY_BY_TYPE[type] = c;
  CATEGORIES.push(c);
  return c;
}

/* Mirrors KNOWN_BRANDS in miniapp_v/index.html. Prom only keeps a vendor
   that exists in its manufacturer base and flags anything else as an
   import error («Невідомий виробник»), so brands missing there are listed
   in PROM_UNKNOWN_VENDORS and simply not sent. */
const KNOWN_BRANDS = [
  [/DAH\s*Solar/i, 'DAH Solar'], [/Dyness/i, 'Dyness'], [/Deye/i, 'Deye'],
  [/Felicity/i, 'Felicity'], [/\bMUST\b/i, 'MUST'], [/\bKBE\b/i, 'KBE'],
  [/EcoFlow/i, 'EcoFlow'], [/\bTTN\b/, 'TTN'],
];
const PROM_UNKNOWN_VENDORS = new Set(['TTN']);
function detectBrand(title) {
  const found = new Set();
  for (const [re, name] of KNOWN_BRANDS) if (re.test(title || '')) found.add(name);
  const brand = found.size === 1 ? [...found][0] : '';
  return PROM_UNKNOWN_VENDORS.has(brand) ? '' : brand;
}

/* ---- Search queries (Prom «Пошукові запити»: <keywords_ua> / <keywords>) ----
   Starts from the merchant_keywords_uk/_ru phrases already in products.json
   (scripts/generate_seo_keywords.py), then tops up with phrases built from
   the product type, brand, model and key spec - Prom asks for at least 8
   queries, and several products have none or only 6. Comma-separated,
   capped at Prom's 1024-char limit on whole phrases. */
const BRAND_PHONETIC = { // same as generate_seo_keywords.py
  'DAH Solar': ['дан солар', 'дан солар'], 'Deye': ['дея', 'дея'],
  'Dyness': ['дайнес', 'дайнес'], 'Felicity': ['селіситі', 'селисити'],
  'MUST': ['маст', 'маст'], 'KBE': ['кбе', 'кбе'],
  'EcoFlow': ['екофлоу', 'экофлоу'], 'TTN': ['ттн', 'ттн'],
};
/* Per group id: [main type word, extra generic queries] in uk and ru. */
const KEYWORD_TYPES = {
  1: { uk: ['гібридний інвертор', ['інвертор', 'інвертор для сонячних панелей', 'інвертор для дому', 'інвертор для резервного живлення']],
       ru: ['гибридный инвертор', ['инвертор', 'инвертор для солнечных панелей', 'инвертор для дома', 'инвертор для резервного питания']] },
  2: { uk: ['акумулятор', ['акумуляторна батарея', 'акумулятор для інвертора', 'акумулятор LiFePO4', 'батарея для інвертора']],
       ru: ['аккумулятор', ['аккумуляторная батарея', 'аккумулятор для инвертора', 'аккумулятор LiFePO4', 'батарея для инвертора']] },
  3: { uk: ['комплект автономного живлення', ['інвертор з акумулятором', 'резервне живлення для дому', 'комплект для дому', 'система резервного живлення']],
       ru: ['комплект автономного питания', ['инвертор с аккумулятором', 'резервное питание для дома', 'комплект для дома', 'система резервного питания']] },
  4: { uk: ['силовий кабель', ['кабель для акумулятора', 'кабель для інвертора', 'мідний кабель', 'кабель з накінечниками']],
       ru: ['силовой кабель', ['кабель для аккумулятора', 'кабель для инвертора', 'медный кабель', 'кабель с наконечниками']] },
  5: { uk: ['безперебійник', ['ДБЖ', 'джерело безперебійного живлення', 'резервне живлення', 'зарядна станція']],
       ru: ['бесперебойник', ['ИБП', 'источник бесперебойного питания', 'резервное питание', 'зарядная станция']] },
  6: { uk: ['акумулятор для ДБЖ', ['акумулятор для безперебійника', 'акумулятор LiFePO4', 'акумуляторна батарея']],
       ru: ['аккумулятор для ИБП', ['аккумулятор для бесперебойника', 'аккумулятор LiFePO4', 'аккумуляторная батарея']] },
  7: { uk: ['система зберігання енергії', ['система зберігання електроенергії', 'інвертор з акумулятором', 'ДБЖ 2 в 1', 'безперебійник для дому']],
       ru: ['система хранения энергии', ['система хранения электроэнергии', 'инвертор с аккумулятором', 'ИБП 2 в 1', 'бесперебойник для дома']] },
};

function keyTokens(title) {
  const t = String(title || '');
  const out = [];
  let m = t.match(/(\d+(?:[.,]\d+)?)\s*[AaАа][hH]\b/);
  if (m) out.push(m[1].replace(',', '.') + 'Ah');
  m = t.match(/(\d+(?:[.,]\d+)?)\s*кВт(?!\s*·?год)/i);
  if (m) out.push(m[1].replace(',', '.') + ' кВт');
  m = t.match(/(\d+(?:[.,]\d+)?)\s*мм/);
  if (m) out.push(m[1] + ' мм');
  return out;
}

function brandsIn(title) {
  return KNOWN_BRANDS.filter(([re]) => re.test(title || '')).map(([, name]) => name);
}

function buildKeywords(p, cat, lang) {
  const li = lang === 'uk' ? 0 : 1;
  const existing = String(p[lang === 'uk' ? 'merchant_keywords_uk' : 'merchant_keywords_ru'] || '')
    .split(',');
  const extra = [];
  const types = KEYWORD_TYPES[cat.id] && KEYWORD_TYPES[cat.id][lang];
  if (types) {
    const [main, generic] = types;
    for (const b of brandsIn(p.title)) {
      extra.push(`${main} ${b}`, `${main} ${BRAND_PHONETIC[b][li]}`);
      if (p.mpn) extra.push(`${b} ${p.mpn}`);
    }
    for (const tok of keyTokens(p.title)) extra.push(`${main} ${tok}`);
    extra.push(main, ...generic);
  }
  if (p.mpn) extra.push(p.mpn);

  const seen = new Set();
  const out = [];
  let len = 0;
  for (const raw of [...existing, ...extra]) {
    const k = raw.replace(/\s+/g, ' ').trim();
    if (!k || k.includes(',') || seen.has(k.toLowerCase())) continue;
    if (len + k.length + (out.length ? 2 : 0) > 1024) break;
    seen.add(k.toLowerCase());
    out.push(k);
    len += k.length + (out.length > 1 ? 2 : 0);
  }
  return out.join(', ');
}

function escXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdata(str) {
  return `<![CDATA[${String(str || '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function decodeEntities(str) {
  return String(str || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function priceUah(raw) {
  const num = parseFloat(String(raw || '').replace(/\s/g, '').replace(',', '.'));
  return isNaN(num) || num <= 0 ? '' : String(Math.round(num * 100) / 100);
}

function absoluteUrl(url) {
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : `${SITE_URL}/${url.replace(/^\//, '')}`;
}

function productLink(p) {
  const slug = p.slug || slugify(p.title || '');
  return `${SITE_URL}/product/${slug}/${encodeURIComponent(p.id)}.html`;
}

/* Rows of the specs table ("Назва | Значення"), skipping section header
   rows (colspan). Become <param> - Prom caps these at 100 per item. */
function specParams(specsHtml) {
  const params = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(specsHtml || '')) && params.length < 100) {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => stripTags(c[1]));
    if (cells.length === 2 && cells[0] && cells[1]) params.push({ name: cells[0], value: cells[1] });
  }
  return params;
}

/* Plain-text description -> paragraphs, plus the specs table without the
   site's inline styles/classes (they reference our CSS variables). */
function descriptionHtml(p) {
  const paras = String(p.description || p.title || '')
    .split(/\n{2,}/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => `<p>${escXml(s).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const specs = String(p.specs || '')
    .replace(/\s(?:style|class)="[^"]*"/gi, '');
  return paras + specs;
}

function buildItem(p) {
  const price = priceUah(p.price);
  if (!price || !p.title) return '';

  const cat    = categoryFor(p.product_type);
  const vendor = detectBrand(p.title);
  /* Only the supplier's original (white-background) photos, copied to our
     server by scripts/fetch_feed.py:download_prom_images - never the
     site's branded ones. No supplier photo -> no <image>, by design. */
  const images = (p.prom_images || [])
    .filter(Boolean)
    .slice(0, 10)
    .map(img => `      <image>${escXml(absoluteUrl(img))}</image>`)
    .join('\n');
  const params = specParams(p.specs)
    .map(s => `      <param name="${escXml(s.name)}">${escXml(s.value)}</param>`)
    .join('\n');
  const desc = cdata(descriptionHtml(p));

  return `
    <item id="${escXml(p.id)}" selling_type="r">
      <name>${escXml(p.title)}</name>
      <name_ua>${escXml(p.title)}</name_ua>
      <categoryId>${cat.id}</categoryId>
${portalFor(p, cat) ? `      <portal_category_id>${portalFor(p, cat)}</portal_category_id>\n` : ''}      <priceuah>${price}</priceuah>
      <url>${escXml(productLink(p))}</url>
${images ? images + '\n' : ''}${vendor ? `      <vendor>${escXml(vendor)}</vendor>\n` : ''}${p.mpn ? `      <vendorCode>${escXml(String(p.mpn).slice(0, 25))}</vendorCode>\n` : ''}      <available>${p.availability === 'in_stock' ? 'true' : 'false'}</available>
      <description>${desc}</description>
      <description_ua>${desc}</description_ua>
      <keywords>${escXml(buildKeywords(p, cat, 'ru'))}</keywords>
      <keywords_ua>${escXml(buildKeywords(p, cat, 'uk'))}</keywords_ua>
${params ? params + '\n' : ''}    </item>`;
}

const items = products.map(buildItem).filter(Boolean);
const usedIds = new Set(products.map(p => categoryFor(p.product_type).id));
const catalog = CATEGORIES
  .filter(c => usedIds.has(c.id))
  .map(c => `    <category id="${c.id}"${c.portal ? ` portal_id="${c.portal}"` : ''}>${escXml(c.name)}</category>`)
  .join('\n');

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<shop>
  <catalog>
${catalog}
  </catalog>
  <items>${items.join('')}
  </items>
</shop>
`;

const outPath = path.join(__dirname, '../prom.xml');
fs.writeFileSync(outPath, xml, 'utf-8');
console.log(`prom.xml generated: ${items.length}/${products.length} products → ${outPath}`);
