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
   strings as SLUG_TO_CATEGORY in assets/js/catalog.js. */
const CATEGORIES = [
  { id: 1, type: 'Автономна енергетика > Гибридні інвертори',                        name: 'Гібридні інвертори' },
  { id: 2, type: 'Автономна енергетика > Акумулятори для гібридних інверторів',      name: 'Акумулятори для гібридних інверторів' },
  { id: 3, type: 'Автономна енергетика > Комплекти автономного енергоживлення',      name: 'Комплекти автономного енергоживлення' },
  { id: 4, type: 'Автономна енергетика > Силові та сонячні кабелі',                  name: 'Силові та сонячні кабелі' },
  { id: 5, type: 'Обладнання > Джерела безперебійного живлення',                     name: 'Джерела безперебійного живлення' },
  { id: 6, type: 'Акумулятори і батарейки > Акумулятори для ДБЖ',                     name: 'Акумулятори для ДБЖ' },
  { id: 7, type: 'Автономна енергетика > Системи зберігання електроенергії 2 в 1',   name: 'Системи зберігання електроенергії 2 в 1' },
];
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
   that exists in its manufacturer base, so an unknown one is harmless. */
const KNOWN_BRANDS = [
  [/DAH\s*Solar/i, 'DAH Solar'], [/Dyness/i, 'Dyness'], [/Deye/i, 'Deye'],
  [/Felicity/i, 'Felicity'], [/\bMUST\b/i, 'MUST'], [/\bKBE\b/i, 'KBE'],
  [/EcoFlow/i, 'EcoFlow'], [/\bTTN\b/, 'TTN'],
];
function detectBrand(title) {
  const found = new Set();
  for (const [re, name] of KNOWN_BRANDS) if (re.test(title || '')) found.add(name);
  return found.size === 1 ? [...found][0] : '';
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
  const images = [p.image_link, ...(p.additional_images || [])]
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
      <priceuah>${price}</priceuah>
      <url>${escXml(productLink(p))}</url>
${images ? images + '\n' : ''}${vendor ? `      <vendor>${escXml(vendor)}</vendor>\n` : ''}${p.mpn ? `      <vendorCode>${escXml(String(p.mpn).slice(0, 25))}</vendorCode>\n` : ''}      <available>${p.availability === 'in_stock' ? 'true' : 'false'}</available>
      <description>${desc}</description>
      <description_ua>${desc}</description_ua>
${params ? params + '\n' : ''}    </item>`;
}

const items = products.map(buildItem).filter(Boolean);
const usedIds = new Set(products.map(p => categoryFor(p.product_type).id));
const catalog = CATEGORIES
  .filter(c => usedIds.has(c.id))
  .map(c => `    <category id="${c.id}">${escXml(c.name)}</category>`)
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
