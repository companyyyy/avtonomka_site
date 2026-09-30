/**
 * Generates Google Merchant Center XML feed (feed.xml) from products.json
 * Run: node scripts/generate_merchant_feed.js
 */

const fs   = require('fs');
const path = require('path');
const { slugify } = require('./slugify');

const SITE_URL    = 'https://avtonomka.com.ua';
const SHOP_NAME   = 'Автономка';
const SHOP_DESC   = 'Магазин обладнання для автономного живлення';

const products = JSON.parse(fs.readFileSync(path.join(__dirname, '../products.json'), 'utf-8'));

/* Віртуальні товари (public.virtual_products, розділ 9.4 ARCHITECTURE.md)
   у Merchant Center фід НЕ потрапляють: у них немає достовірної ціни
   (не оновлюються з прайсу постачальника), а Merchant без ціни товар
   відхиляє. Вони лишаються тільки як SEO-сторінки на сайті + в sitemap.xml
   (див. scripts/generate_static_pages.js). */

function escXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatPrice(raw) {
  const num = parseFloat(raw);
  if (isNaN(num)) return '';
  return num.toFixed(2) + ' UAH';
}

function availability(val) {
  return val === 'in_stock' ? 'in stock' : 'out of stock';
}

function productLink(p) {
  const slug = p.slug || slugify(p.title || '');
  return `${SITE_URL}/product/${slug}/${encodeURIComponent(p.id)}.html`;
}

function absoluteUrl(url) {
  if (!url) return '';
  return url.startsWith('http') ? url : `${SITE_URL}/${url.replace(/^\//, '')}`;
}

/* Опис для фіду: лише текст опису товару (без HTML), БЕЗ merchant_keywords_uk/ru.
   Раніше в кінець дописувався хвіст ключових слів (UA + RU, з «екодрайв»);
   Merchant вважає це keyword stuffing, а RU-частина - текстом не тією мовою.
   Поля merchant_keywords_* лишаються в products.json для generate_prom_feed.js.
   Немає опису -> назва товару (і товар іде у звіт validate_merchant_feed.js). */
function plainText(text) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function feedDescription(p) {
  return plainText(p.description) || feedTitle(p);
}

/* Бренд = реальний виробник, перший, що трапляється в назві (для комплекту
   «Комплект ...: <інвертор> + <АКБ>» це бренд інвертора). Немає бренду в
   назві -> g:brand не пишемо (і identifier_exists=no), нічого не вигадуємо. */
const BRANDS = [
  ['Felicity', /felicity/i],
  ['MUST', /\bmust\b/i],
  ['Dyness', /dyness/i],
  ['Deye', /\bdeye\b/i],
  ['EcoFlow', /ecoflow/i],
  ['KBE', /\bkbe\b/i],
  ['TTN', /\bttn\b/i],
];

function detectBrand(title) {
  let best = null;
  for (const [name, re] of BRANDS) {
    const m = re.exec(title || '');
    if (m && (!best || m.index < best.index)) best = { name, index: m.index };
  }
  return best ? best.name : '';
}

/* Б/в товари: condition=used, а в назві явна позначка «(Trade-IN, б/в)». */
const USED_RE = /trade[\s-]?in|б\/у|б\/в|бул[аи]? у використанні|був у використанні/i;

function isUsed(p) {
  return USED_RE.test(`${p.title} ${p.description}`);
}

function feedTitle(p) {
  const title = p.title || '';
  if (!isUsed(p) || /\(Trade-IN, б\/в\)/.test(title)) return title;
  return title.replace(/,?\s*Trade[\s-]?IN\s*$/i, '') + ' (Trade-IN, б/в)';
}

/* MPN: тільки справжній артикул виробника. Постачальник подекуди ставить
   службові коди або помилки - виправляємо/прибираємо тут, у фіді. */
const MPN_FIX = {
  '150599': 'LP15-12100',   // було LP1500-12100, у назві LP15-12100
  '152264': 'LP15-24100',   // було LFP1500-24100, у назві LP15-24100
  '152723': 'HBP18-1212 OS', // було HBP18-1012 OS, правильна модель HBP18-1212 OS
};
const MPN_INVALID = new Set([
  '3kwt',            // не артикул - «3 кВт» у двох різних комплектах
  'KBE_Solar',       // один «код» на три різні кабелі (колір, довжина)
  '4AWG-2050',       // складено з перерізу й довжини, не артикул Dyness
  'DL5.0C_Heating',  // службовий код; справжній артикул версії з підігрівом невідомий
  'EFDELTA3',        // не підтверджений артикул EcoFlow (EF DELTA2 EU для Delta 2 лишаємо)
]);

function feedMpn(p) {
  const mpn = MPN_FIX[p.id] || (p.mpn || '').trim();
  return MPN_INVALID.has(mpn) ? '' : mpn;
}

const KIT_TYPE = 'Автономна енергетика > Комплекти автономного енергоживлення';

function isBundle(p) {
  return p.product_type === KIT_TYPE || /^Комплект автономного енергоживлення/i.test(p.title || '');
}

/* Google product taxonomy (https://www.google.com/basepages/producttype/taxonomy-with-ids.en-US.txt). */
const GOOGLE_CATEGORY = {
  'Автономна енергетика > Акумулятори для гібридних інверторів': 276,   // Electronics > ... > Power > Batteries
  'Акумулятори і батарейки > Акумулятори для ДБЖ':                6289,  // ... > Power > Batteries > UPS Batteries
  'Автономна енергетика > Гибридні інвертори':                     5142,  // Hardware > Power & Electrical Supplies > Power Inverters
  [KIT_TYPE]:                                                      5142,
  'Автономна енергетика > Системи зберігання електроенергії 2 в 1': 5142,
  'Обладнання > Джерела безперебійного живлення':                  1348,  // Electronics > ... > Power > UPS (EcoFlow, ДБЖ для роутера)
  'Автономна енергетика > Силові та сонячні кабелі':               2345,  // Hardware > ... > Electrical Wires & Cable
};

/* У product_type постачальника «Гибридні» - це ключ (знижки, каталог, Supabase),
   тому в products.json його не чіпаємо, виправляємо лише текст у фіді. */
function feedProductType(p) {
  return (p.product_type || '').replace('Гибридні інвертори', 'Гібридні інвертори');
}

/* Фото в Merchant:
   - комплекти - брендовані фото сайту з фоном (image_link), як на сайті;
   - окремі товари - фото постачальника на білому фоні (p.prom_images,
     їх качає scripts/fetch_feed.py:download_prom_images);
   - assets/images/merchant/<id>.jpg - ручне біле фото, коли в постачальника
     його немає (має пріоритет над усім).
   Немає білого фото -> лишається image_link, бо без фото Merchant товар відхиляє. */
const MERCHANT_IMAGES_DIR = path.join(__dirname, '../assets/images/merchant');
const merchantImages = fs.existsSync(MERCHANT_IMAGES_DIR)
  ? Object.fromEntries(fs.readdirSync(MERCHANT_IMAGES_DIR)
      .map(f => [path.parse(f).name, `assets/images/merchant/${f}`]))
  : {};

function isKit(p) {
  return /Комплект/i.test(p.product_type || '');
}

function feedImages(p) {
  if (merchantImages[p.id]) return [merchantImages[p.id]];
  if (!isKit(p) && (p.prom_images || []).length) return p.prom_images;
  return [p.image_link, ...(p.additional_images || [])];
}

function buildItem(p) {
  const price = formatPrice(p.price);
  if (!price) return '';

  const [mainImage, ...restImages] = feedImages(p).filter(Boolean);
  const additionalImages = restImages
    .slice(0, 10)
    .map(img => `      <g:additional_image_link>${escXml(absoluteUrl(img))}</g:additional_image_link>`)
    .join('\n');

  const brand = detectBrand(p.title);
  const mpn = feedMpn(p);
  const gtin = (p.gtin || '').trim();
  const gcat = GOOGLE_CATEGORY[p.product_type];
  const opt = (tag, val) => (val ? `      <g:${tag}>${escXml(val)}</g:${tag}>\n` : '');

  return `
    <item>
      <g:id>${escXml(p.id)}</g:id>
      <g:title>${escXml(feedTitle(p))}</g:title>
      <g:description>${escXml(feedDescription(p))}</g:description>
      <g:link>${escXml(productLink(p))}</g:link>
      <g:image_link>${escXml(absoluteUrl(mainImage))}</g:image_link>
${additionalImages ? additionalImages + '\n' : ''}      <g:price>${price}</g:price>
      <g:availability>${availability(p.availability)}</g:availability>
      <g:condition>${isUsed(p) ? 'used' : escXml(p.condition || 'new')}</g:condition>
${opt('brand', brand)}${opt('gtin', gtin)}${opt('mpn', mpn)}${!gtin && (!mpn || !brand) ? '      <g:identifier_exists>no</g:identifier_exists>\n' : ''}${isBundle(p) ? '      <g:is_bundle>yes</g:is_bundle>\n' : ''}${gcat ? `      <g:google_product_category>${gcat}</g:google_product_category>\n` : ''}      <g:product_type>${escXml(feedProductType(p))}</g:product_type>
    </item>`;
}

(async () => {
  const items = products.map(buildItem).filter(Boolean).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${escXml(SHOP_NAME)}</title>
    <link>${SITE_URL}</link>
    <description>${escXml(SHOP_DESC)}</description>
${items}
  </channel>
</rss>
`;

  const outPath = path.join(__dirname, '../feed.xml');
  fs.writeFileSync(outPath, xml, 'utf-8');
  console.log(`feed.xml generated: ${products.length} products → ${outPath}`);
})();
