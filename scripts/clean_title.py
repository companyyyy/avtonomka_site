"""
Прибирає з назви товару габарити (700х430х253) і вагу (71 кг).

Постачальник (dfi2) пише їх прямо в назву, а fetch_feed.py щоразу
перезаписує products.json з його фіду, тому чистимо на кожному
оновленні, а не руками. Ті самі правила в scripts/clean_title.js
(віртуальні товари з Supabase) - міняти обидва разом.
"""

import re

_NUM = r"\d+(?:\.\d+)?"
# Роздільник «х» буває кириличний, латинський або ×.
_DIMS = rf"{_NUM}\s*[xхX×]\s*{_NUM}\s*[xхX×]\s*{_NUM}(?:\s*мм)?"
_WEIGHT = rf"{_NUM}\s*(?:кг|kg)(?!\w)"
_TOKEN = re.compile(rf"\s*,?\s*(?<![\w.])(?:{_DIMS}|{_WEIGHT})", re.I)


def clean_title(title: str) -> str:
    s = _TOKEN.sub("", title or "")
    s = re.sub(r"\s*,\s*(?=,|$)", "", s)   # коми, що лишились без сусіда
    return re.sub(r"\s{2,}", " ", s).strip(" ,")
