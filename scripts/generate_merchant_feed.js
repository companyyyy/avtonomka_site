/**
 * Generates Google Merchant Center XML feed (feed.xml) from products.json
 * Run: node scripts/generate_merchant_feed.js
 */

const fs   = require('fs');
const path = require('path');
const { slugify } = require('./slugify');

const SITE_URL    = 'https://avtonomka.com.ua';
const BRAND       = 'Автономка';
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

/* Bilingual SEO keyword phrases (see scripts/generate_seo_keywords.py),
   appended to the feed-only description. Deliberately NOT part of
   p.description itself, which product.js / generate_static_pages.js /
   catalog.js also read for the on-site description — this keeps that
   text keyword-free while still letting the feed carry the extra terms,
   per the user's explicit call after being shown Google's Merchant Center
   policy against keyword stuffing (accepted the risk knowingly). */
function feedDescription(p) {
  const base = p.description || p.title;
  const kw = [p.merchant_keywords_uk, p.merchant_keywords_ru].filter(Boolean).join(' ');
  return kw ? `${base} ${kw}` : base;
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

  return `
    <item>
      <g:id>${escXml(p.id)}</g:id>
      <g:title>${escXml(p.title)}</g:title>
      <g:description>${escXml(feedDescription(p))}</g:description>
      <g:link>${escXml(productLink(p))}</g:link>
      <g:image_link>${escXml(absoluteUrl(mainImage))}</g:image_link>
${additionalImages ? additionalImages + '\n' : ''}      <g:price>${price}</g:price>
      <g:availability>${availability(p.availability)}</g:availability>
      <g:condition>${escXml(p.condition || 'new')}</g:condition>
      <g:brand>${escXml(BRAND)}</g:brand>
      <g:product_type>${escXml(p.product_type)}</g:product_type>
${p.mpn ? `      <g:mpn>${escXml(p.mpn)}</g:mpn>\n` : ''}    </item>`;
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
