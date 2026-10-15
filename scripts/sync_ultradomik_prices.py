"""
Copies site prices and stock (products.json, supplier feed) into
data/ultradomik/prices.json - the price table of /prom-admin/ that
prom_file.xml (Ultradomik) and invertorshop.xml are built from.

Runs in the scheduled site update (.github/workflows/update.yml) right after
products.json is refreshed. A price edited by hand in /prom-admin/ between two
updates goes into the feeds at once (prom-feed.yml) and stays until the next
scheduled update, which overwrites it with the site price again.
Items that have no card on the site (feed_only, ud-avr-*, items gone from the
supplier feed) or no site price keep their manual values.
The random +1..10 UAH is added later, in generate_ultradomik_feed.py.
The wholesale price ("wholesale", feed/opt.xml) is set by hand only - kept as is.

Run: python scripts/sync_ultradomik_prices.py
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRICES = ROOT / 'data/ultradomik/prices.json'


def site_price(raw):
    """'14926 UAH' -> 14926; anything else (empty, other currency) -> None."""
    parts = str(raw or '').split()
    if len(parts) != 2 or parts[1] != 'UAH':
        return None
    try:
        value = float(parts[0].replace(',', '.'))
    except ValueError:
        return None
    if value <= 0:
        return None
    return int(value) if value.is_integer() else round(value, 2)


def main():
    products = {str(p['id']): p for p in json.loads((ROOT / 'products.json').read_text('utf-8'))}
    entries = json.loads((ROOT / 'data/ultradomik/products.json').read_text('utf-8'))
    prices = json.loads(PRICES.read_text('utf-8'))

    ids = [pid for e in entries if not e.get('feed_only') for pid in e['ids']]
    changed, kept = [], []
    for pid in ids:
        p = products.get(pid)
        price = site_price(p.get('price')) if p else None
        if price is None:
            kept.append(pid)
            continue
        new = {'price': price, 'in_stock': p.get('availability') == 'in_stock'}
        old = prices.get(pid, {})
        if old.get('price') != new['price'] or old.get('in_stock') != new['in_stock']:
            changed.append(f'{pid}: {old.get("price")} -> {price}'
                           f'{"" if new["in_stock"] else " (немає в наявності)"}')
        prices[pid] = {**old, **new}

    PRICES.write_text(json.dumps(prices, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'prices.json: {len(changed)} changed from site, {len(kept)} kept manual')
    for line in changed:
        print('  ' + line)
    if kept:
        print('  manual (no site price): ' + ', '.join(kept))


if __name__ == '__main__':
    main()
