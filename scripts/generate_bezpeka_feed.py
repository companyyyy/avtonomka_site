"""
Generates the YML price feed for the Bezpeka.club marketplace:
feed/bezpeka.xml, served at https://avtonomka.com.ua/feed/bezpeka.xml
(the link is handed to info@bezpeka.club; their side pulls it by URL).

Source: products.json - the same items and retail prices as the site.
Photos follow the Merchant feed rule: a white-background copy
(assets/images/merchant/<id>.*, then prom_images) for single items, the
site's branded photos for kits. Specs tables (p["specs"]) become <param>.

Required in every offer: id, categoryId, available, name, price, picture,
vendor, description, warranty. An item missing any of them is left out and
listed in the report printed at the end (Actions log).

Run: python scripts/generate_bezpeka_feed.py
"""

import html
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from xml.sax.saxutils import escape
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).parent))
from clean_title import clean_title

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
SITE_URL = 'https://avtonomka.com.ua'
OUTPUT = ROOT / 'feed' / 'bezpeka.xml'

SHOP_NAME = 'Автономка'
SHOP_COMPANY = 'Автономка'

# No per-item warranty in the data yet - one term for everything (months).
WARRANTY_MONTHS = 12
# stock_quantity 1..FEW_THRESHOLD -> "few". products.json has no quantities
# today, so this only kicks in once a "stock_quantity" field appears.
FEW_THRESHOLD = 3

# Category ids are fixed - never renumber, only append.
CATEGORIES = {
    'Автономна енергетика > Комплекти автономного енергоживлення': (1, 'Комплекти автономного енергоживлення'),
    'Автономна енергетика > Гибридні інвертори': (2, 'Гібридні інвертори'),
    'Автономна енергетика > Акумулятори для гібридних інверторів': (3, 'Акумулятори для гібридних інверторів'),
    'Автономна енергетика > Системи зберігання електроенергії 2 в 1': (4, 'Системи зберігання енергії 2 в 1'),
    'Обладнання > Джерела безперебійного живлення': (5, 'Джерела безперебійного живлення'),
    'Акумулятори і батарейки > Акумулятори для ДБЖ': (6, 'Акумулятори для ДБЖ'),
    'Автономна енергетика > Силові та сонячні кабелі': (7, 'Силові та сонячні кабелі'),
    'Автономна енергетика > Wi-Fi модули для гібридних інверторів': (8, 'Wi-Fi модулі для інверторів'),
}

# Same list and rule as detectBrand() in generate_merchant_feed.js: the first
# brand in the title (for a kit that is the inverter's brand).
BRANDS = [
    ('Felicity', re.compile(r'felicity', re.I)),
    ('MUST', re.compile(r'\bmust\b', re.I)),
    ('Dyness', re.compile(r'dyness', re.I)),
    ('Deye', re.compile(r'\bdeye\b', re.I)),
    ('EcoFlow', re.compile(r'ecoflow', re.I)),
    ('KBE', re.compile(r'\bkbe\b', re.I)),
    ('TTN', re.compile(r'\bttn\b', re.I)),
    ('DAH Solar', re.compile(r'dah\s*solar', re.I)),
]

# Mirrors MPN_FIX / MPN_INVALID in generate_merchant_feed.js.
MPN_FIX = {
    '150599': 'LP15-12100',
    '152264': 'LP15-24100',
    '152723': 'HBP18-1212 OS',
}
MPN_INVALID = {'3kwt', 'KBE_Solar', '4AWG-2050', 'DL5.0C_Heating', 'EFDELTA3'}

MERCHANT_IMAGES_DIR = ROOT / 'assets' / 'images' / 'merchant'


def detect_vendor(title):
    best = None
    for name, rx in BRANDS:
        m = rx.search(title or '')
        if m and (best is None or m.start() < best[1]):
            best = (name, m.start())
    return best[0] if best else ''


def model(p):
    mpn = MPN_FIX.get(p['id']) or (p.get('mpn') or '').strip()
    return '' if mpn in MPN_INVALID else mpn


def is_kit(p):
    return 'Комплект' in (p.get('product_type') or '')


def absolute_url(url):
    if not url:
        return ''
    return url if url.startswith('http') else f"{SITE_URL}/{url.lstrip('/')}"


def pictures(p):
    if MERCHANT_IMAGES_DIR.exists():
        for f in sorted(MERCHANT_IMAGES_DIR.iterdir()):
            if f.stem == p['id']:
                return [absolute_url(f'assets/images/merchant/{f.name}')]
    if not is_kit(p) and p.get('prom_images'):
        imgs = p['prom_images']
    else:
        imgs = [p.get('image_link')] + list(p.get('additional_images') or [])
    out = []
    for img in imgs:
        if not img or 'zaglushka' in img:
            continue
        if not img.startswith('http') and not (ROOT / img).exists():
            continue
        out.append(absolute_url(img))
    return out[:10]


def price(p):
    m = re.match(r'^\s*([\d.,]+)', p.get('price') or '')
    if not m:
        return ''
    value = round(float(m.group(1).replace(',', '.')))
    return str(value) if value > 0 else ''


def available(p):
    qty = p.get('stock_quantity')
    if isinstance(qty, int):
        if qty > FEW_THRESHOLD:
            return 'true'
        if qty > 0:
            return 'few'
    status = p.get('availability')
    if status == 'in_stock' and qty is None:
        return 'true'
    if status in ('preorder', 'backorder'):
        return 'expected'
    return 'false'


def description_html(p):
    text = (p.get('description') or '').strip()
    if not text:
        return ''
    # One line = one paragraph (the texts use both single and blank-line breaks).
    paragraphs = [line.strip() for line in text.splitlines() if line.strip()]
    # The first line repeats the title - drop it.
    # (compared cleaned: the description may still carry the supplier's title
    # with dimensions/weight that clean_title() removed from the title itself)
    if paragraphs and clean_title(paragraphs[0]) == clean_title(p.get('title')):
        paragraphs = paragraphs[1:]
    return ''.join(f"<p>{html.escape(para, quote=False)}</p>" for para in paragraphs)


def cdata(s):
    return '<![CDATA[' + s.replace(']]>', ']]]]><![CDATA[>') + ']]>'


def params(p):
    out = []
    for row in re.findall(r'<tr>(.*?)</tr>', p.get('specs') or '', re.S):
        cells = re.findall(r'<td[^>]*>(.*?)</td>', row, re.S)
        if len(cells) != 2:
            continue  # section header row
        name, value = (html.unescape(re.sub(r'<[^>]+>', '', c)).strip() for c in cells)
        if name and value:
            out.append((name, value))
    return out


def product_url(p):
    return f"{SITE_URL}/product/{p['slug']}/{p['id']}.html" if p.get('slug') else ''


def esc(s):
    return escape(str(s), {'"': '&quot;', "'": '&apos;'})


def build_offer(p):
    cat = CATEGORIES.get(p.get('product_type'))
    fields = {
        'categoryId': cat[0] if cat else '',
        'name': (p.get('title') or '').strip(),
        'price': price(p),
        'picture': pictures(p),
        'vendor': detect_vendor(p.get('title')),
        'description': description_html(p),
        'warranty': WARRANTY_MONTHS,
    }
    missing = [k for k, v in fields.items() if not v]
    if missing:
        return None, missing

    lines = [f'      <offer id="{esc(p["id"])}">']
    url = product_url(p)
    if url:
        lines.append(f'        <url>{esc(url)}</url>')
    lines.append(f'        <categoryId>{fields["categoryId"]}</categoryId>')
    lines.append(f'        <available>{available(p)}</available>')
    lines.append(f'        <name>{esc(fields["name"])}</name>')
    lines.append(f'        <price>{fields["price"]}</price>')
    for pic in fields['picture']:
        lines.append(f'        <picture>{esc(pic)}</picture>')
    lines.append(f'        <vendor>{esc(fields["vendor"])}</vendor>')
    mdl = model(p)
    if mdl:
        lines.append(f'        <model>{esc(mdl)}</model>')
    if isinstance(p.get('stock_quantity'), int):
        lines.append(f'        <stock_quantity>{p["stock_quantity"]}</stock_quantity>')
    lines.append(f'        <description>{cdata(fields["description"])}</description>')
    lines.append(f'        <warranty>{fields["warranty"]}</warranty>')
    for name, value in params(p):
        lines.append(f'        <param name="{esc(name)}">{esc(value)}</param>')
    lines.append('      </offer>')
    return '\n'.join(lines), None


def main():
    products = json.loads((ROOT / 'products.json').read_text(encoding='utf-8'))
    offers, skipped = [], []
    for p in products:
        offer, missing = build_offer(p)
        if offer:
            offers.append(offer)
        else:
            skipped.append((p['id'], p.get('title', ''), missing))

    date = datetime.now(ZoneInfo('Europe/Kyiv')).strftime('%Y-%m-%d %H:%M')
    used_cats = sorted(set(CATEGORIES.values()))
    xml = '\n'.join([
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<yml_catalog date="{date}">',
        '  <shop>',
        f'    <name>{esc(SHOP_NAME)}</name>',
        f'    <company>{esc(SHOP_COMPANY)}</company>',
        f'    <url>{SITE_URL}</url>',
        '    <currencies>',
        '      <currency id="UAH" rate="1"/>',
        '    </currencies>',
        '    <categories>',
        *[f'      <category id="{cid}">{esc(name)}</category>' for cid, name in used_cats],
        '    </categories>',
        '    <offers>',
        *offers,
        '    </offers>',
        '  </shop>',
        '</yml_catalog>',
        '',
    ])
    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(xml, encoding='utf-8')

    print(f'Bezpeka.club: {OUTPUT.relative_to(ROOT)} - у фіді {len(offers)}, відсіяно {len(skipped)}')
    for pid, title, missing in skipped:
        print(f'  відсіяно {pid} ({title[:70]}): бракує {", ".join(missing)}')


if __name__ == '__main__':
    main()
