"""
Validates feed.xml (Google Merchant) against the rules agreed for the feed.
Exits with code 1 and a list of problems if any rule is broken:
  - feed is not well-formed XML, or has no items;
  - g:brand is «Автономка» (must be the real manufacturer or absent);
  - «ecodrive» / «екодрайв» / «экодрайв» or Russian text anywhere in an item;
  - an item has neither gtin/mpn nor identifier_exists=no;
  - one MPN shared by items with different titles (except ALLOWED_MPN_DUPES);
  - an item mentions Trade-IN / б/в but condition is not «used».
Also prints (without failing) items that need a manual look: no brand, short
description, no google_product_category.

Run: python scripts/validate_merchant_feed.py [path/to/feed.xml]
"""

import re
import sys
from collections import defaultdict
from pathlib import Path
from xml.etree import ElementTree

G = '{http://base.google.com/ns/1.0}'
FEED = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / 'feed.xml'

# Same product sold twice (e.g. PV19-6048EXP with and without Wi-Fi) - OK to share an MPN.
ALLOWED_MPN_DUPES = {'PV19-6048EXP'}

ECODRIVE = re.compile(r'ecodrive|екодрайв|экодрайв', re.I)
# Letters that do not exist in Ukrainian + common Russian words from the old keyword tail.
RUSSIAN = re.compile(r'[ыэъё]|\b(аккумулятор\w*|инвертор\w*|для дома|питани[ея]|напряжени[ея]|емкост\w*|'
                     r'солнечн\w*|который|также|переходник\w*|розетки китайск\w*)\b', re.I)
USED = re.compile(r'trade[\s-]?in|б/у|б/в|бул[аи]? у використанні|був у використанні', re.I)


def text(item, tag):
    el = item.find(G + tag)
    return (el.text or '').strip() if el is not None else ''


def main():
    try:
        root = ElementTree.parse(FEED).getroot()
    except ElementTree.ParseError as exc:
        sys.exit(f'{FEED}: invalid XML - {exc}')
    items = root.findall('./channel/item')
    errors, notes = [], defaultdict(list)
    mpns = defaultdict(list)

    if not items:
        errors.append('no <item> in feed')

    for it in items:
        pid, title, desc = text(it, 'id'), text(it, 'title'), text(it, 'description')
        label = f'{pid} {title[:70]}'
        brand, mpn, gtin = text(it, 'brand'), text(it, 'mpn'), text(it, 'gtin')
        blob = ' '.join((el.text or '') for el in it.iter())

        if brand.lower() == 'автономка':
            errors.append(f'{label}: brand «Автономка»')
        if ECODRIVE.search(blob):
            errors.append(f'{label}: містить ecodrive/екодрайв')
        m = RUSSIAN.search(blob)
        if m:
            errors.append(f'{label}: російський текст «{m.group(0)}»')
        if not gtin and not mpn and text(it, 'identifier_exists') != 'no':
            errors.append(f'{label}: немає gtin/mpn і немає identifier_exists=no')
        if USED.search(title + ' ' + desc) and text(it, 'condition') != 'used':
            errors.append(f'{label}: Trade-IN / б/в, але condition не used')
        if mpn:
            mpns[mpn].append((pid, title))

        if not brand:
            notes['Без бренду'].append(label)
        if len(desc) < 50 or desc == title:
            notes['Потрібен нормальний опис (зараз лише назва або < 50 символів)'].append(label)
        if not text(it, 'google_product_category'):
            notes['Без google_product_category'].append(label)

    for mpn, rows in mpns.items():
        if len({t for _, t in rows}) > 1:
            line = f'MPN {mpn}: ' + ', '.join(pid for pid, _ in rows)
            if mpn in ALLOWED_MPN_DUPES:
                notes['Дозволені дублі MPN (один і той самий товар)'].append(line)
            else:
                errors.append(line + ' - різні товари з одним MPN')

    print(f'{FEED.name}: {len(items)} items')
    for head, rows in notes.items():
        print(f'\n{head} ({len(rows)}):')
        for r in rows:
            print(f'  - {r}')
    if errors:
        print(f'\nПОМИЛКИ ({len(errors)}):')
        for e in errors:
            print(f'  - {e}')
        sys.exit(1)
    print('\nOK: помилок немає')


if __name__ == '__main__':
    main()
