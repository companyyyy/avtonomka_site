// b2b - бекенд B2B-кабінету (/b2b/) і розділу адмінки «B2B» (b2b-admin/).
// Схема: scripts/supabase/b2b_schema.sql. Інструкція: docs/B2B.md.
//
// Запит: POST JSON { action, ... }, заголовок Authorization: Bearer <JWT>
// (supabase-js functions.invoke ставить його сам: сесію користувача або anon-ключ).
//
// Без входу:
//   apply        { company, edrpou?, contact_name, phone, email, city?, comment? } - заявка на доступ
// B2B-клієнт (app_metadata.role = 'b2b', статус approved):
//   me           - профіль і статус (працює і для заблокованого - щоб показати причину);
//                  affiliate_enabled - чи показувати вкладку «Партнерська програма»
//   catalog      - товари з гуртовими цінами ($ і грн), курс, РРЦ, спецціни клієнта, обране;
//                  cat - категорія кабінету (B2B_CATEGORIES), cats - їх порядок для плиток
//   fav          { id, on }                    - додати / прибрати з обраного
//   order        { client_key, items: [{ id, qty }], city?, np_branch?, payment_method?, comment?, points? }
//                  np_branch - «Служба: відділення / адреса», напр. «Укрпошта: 01001, вул. ...»
//                  points - оплатити частину балами партнерської програми (функція affiliate,
//                  docs/AFFILIATE.md; лише з affiliate_enabled); не вдалося списати - замовлення
//                  все одно приймається, points_error
//   orders       - мої замовлення
// Адмін (tg_admins):
//   admin_list
//   admin_approve { id, password? }            - створює вхід клієнту, повертає пароль
//   admin_create  { company, email, ..., password? } - клієнт одразу зі входом
//   admin_update  { id, status?, manager_note?, password?, company?, edrpou?, contact_name?, phone?, city?,
//                   affiliate_enabled? } - affiliate_enabled: галочка «Партнерська програма» для клієнта
//   admin_special_get { id }                   - каталог і спецціни клієнта
//   admin_special_set { id, prices: { <product_id>: число | null } } - null = прибрати спецціну
//
// Ціни - ті самі, що у feed/opt.xml: wholesale_usd × usd_rate з
// data/ultradomik/prices.json і feeds.json (редагуються в /prom-admin/).
// Функція читає їх із сайту, тож зміна ціни в адмінці діє тут одразу після
// оновлення файлів на сайті (1-2 хв), без окремої синхронізації.
// Спецціна (b2b_special_prices) - окрема ціна товару для окремого клієнта;
// де вона є, замовлення рахується за нею.
//
// Замовлення також дописуються в Google Таблицю «Заявки» (де й замовлення з
// сайту) - той самий Apps Script, що в assets/js/cart.js (ORDER_SHEET), джерело «B2B».
//
// Секрети: TELEGRAM_BOT_TOKEN, MANAGER_CHAT_ID (як для order-submit; без них
// просто немає сповіщень). SUPABASE_URL і SUPABASE_SERVICE_ROLE_KEY Supabase додає сам.

import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const MANAGER_CHAT_ID = Deno.env.get("MANAGER_CHAT_ID") ?? "";
const TG_API = Deno.env.get("TELEGRAM_API_BASE") ?? "https://api.telegram.org";
const SITE_URL = (Deno.env.get("SITE_URL") ?? "https://avtonomka.com.ua").replace(/\/$/, "");
const MAX_ITEMS = 100;
// ⚠ Той самий URL, що ORDER_SHEET в assets/js/cart.js і CONFIG.ORDERS_URL у miniapp_v/index.html.
const ORDER_SHEET = Deno.env.get("ORDER_SHEET_URL") ??
  "https://script.google.com/macros/s/AKfycbz7JbuQpZmBlUck24Bjp7SGKZL-JqE_clqLuYb9y15QG4-FSk45ZkpPHf5faZWISHcE/exec";

// Код товару для клієнтів = id постачальника − 140000 (152517 → 12517).
// Назад: код + 140000. Те саме - productCode() у prom-admin/ і b2b/.
const CODE_OFFSET = 140000;
export function productCode(id: string) {
  return /^\d+$/.test(id) && Number(id) > CODE_OFFSET ? String(Number(id) - CODE_OFFSET) : id;
}

// Як CATEGORIES у scripts/generate_ultradomik_feed.py.
const CATEGORIES: Record<number, string> = {
  1: "Гібридні інвертори", 2: "Акумулятори", 3: "Системи зберігання 2 в 1", 4: "Кабельна продукція",
  5: "Зарядні станції", 6: "Безперебійники для роутерів", 7: "АВР", 8: "Реле напруги", 9: "Таймери",
  10: "Лічильники електроенергії", 11: "Комплекти", 12: "Wi-Fi модулі", 13: "Інше обладнання", 14: "Генератори",
};

// Категорії кабінету - у порядку плиток. Акумулятори діляться на «до гібридних
// інверторів» і «до ДБЖ» за категорією товару на сайті, Wi-Fi модулі йдуть разом
// з інверторами. Комплектів у кабінеті немає (їх збирають із цих же товарів).
const B2B_CATEGORIES = [
  "Гібридні інвертори", "Акумулятори до гібридних інверторів", "Акумулятори до ДБЖ", "Зарядні станції",
  "Системи зберігання 2 в 1", "Генератори", "Кабельна продукція", "Безперебійники для роутерів", "АВР", "Реле напруги",
  "Таймери", "Лічильники електроенергії", "Інше обладнання",
];
const NO_B2B_CATS = new Set([11]);

function b2bCategory(cat: number, siteType: string | undefined) {
  if (cat === 12) return "Гібридні інвертори";
  if (cat === 2) return /ДБЖ/.test(siteType ?? "") ? "Акумулятори до ДБЖ" : "Акумулятори до гібридних інверторів";
  const name = CATEGORIES[cat] ?? "";
  return B2B_CATEGORIES.includes(name) ? name : "Інше обладнання";
}

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

const text = (v: unknown, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "") || null;
const escHtml = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (n: number) => `${Math.round(n).toLocaleString("uk-UA")} грн`;
const isEmail = (s: string | null) => !!s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

// Як normalizePhone в order-submit.
function normalizePhone(p: string) {
  const d = (p ?? "").replace(/\D/g, "");
  if (/^380\d{9}$/.test(d)) return d;
  if (/^80\d{9}$/.test(d)) return "3" + d;
  if (/^0\d{9}$/.test(d)) return "38" + d;
  return d || null;
}

function genPassword() {
  const abc = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(10));
  return [...b].map((x) => abc[x % abc.length]).join("");
}

async function notifyManager(lines: string[]) {
  if (!MANAGER_CHAT_ID || !BOT_TOKEN) return;
  try {
    await fetch(`${TG_API}/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: MANAGER_CHAT_ID, text: lines.filter((l) => l !== "").join("\n"), parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch (e) {
    console.error("b2b: Telegram", e);
  }
}

// Рядки в Google Таблицю «Заявки» - у тому ж форматі, що надсилає кошик сайту
// (checkout.js): один рядок на товар. Скрипт таблиці - scripts/order_form_apps_script.gs.
async function sendToSheet(fields: Record<string, string>, items: { title: string; sku: string; qty: number; price: number | null }[]) {
  try {
    const r = await fetch(ORDER_SHEET, {
      method: "POST",
      body: new URLSearchParams({ ...fields, items: JSON.stringify(items.map((i) => ({ ...i, currency: "UAH" }))) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) console.error("b2b: Google Таблиця", r.status);
  } catch (e) {
    console.error("b2b: Google Таблиця", e);
  }
}

// Фонова задача: відповідь клієнту не чекає на Google (якщо рантайм це вміє).
function background(p: Promise<unknown>) {
  const rt = (globalThis as any).EdgeRuntime;
  return rt?.waitUntil ? (rt.waitUntil(p), Promise.resolve()) : p;
}

// ─── Каталог ────────────────────────────────────────────────────────────

type Item = { id: string; code: string; name: string; cat: string; photo: string; url: string | null; mpn: string | null; usd: number | null; price: number | null; rrp: number | null; available: boolean };
let cache: { at: number; items: Item[] } | null = null;
let usdRate = 45; // курс із feeds.json, оновлюється разом із каталогом

async function siteJson(path: string) {
  const r = await fetch(`${SITE_URL}/${path}?t=${Date.now()}`, { headers: { "Cache-Control": "no-cache" } });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

async function catalog(): Promise<Item[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.items;
  const [feedItems, prices, feeds, products] = await Promise.all([
    siteJson("data/ultradomik/feed_items.json"),
    siteJson("data/ultradomik/prices.json"),
    siteJson("data/ultradomik/feeds.json"),
    siteJson("products.json"),
  ]);
  const rate = Number(feeds?.usd_rate) > 0 ? Number(feeds.usd_rate) : 45;
  usdRate = rate;
  const site = new Map<string, any>((products as any[]).map((p) => [String(p.id), p]));
  const abs = (u: string) => (!u ? "" : /^https?:/.test(u) ? u : `${SITE_URL}/${u.replace(/^\//, "")}`);

  const items: Item[] = [];
  for (const it of feedItems as any[]) {
    if (it.problem === "немає товару на сайті") continue; // зник з сайту - як і з фідів
    if (NO_B2B_CATS.has(it.cat)) continue;
    const id = String(it.id);
    const p = prices[id] ?? {};
    const s = site.get(id);
    const usd = Number(p.wholesale_usd) || 0;
    items.push({
      id,
      code: productCode(id),
      name: it.name,
      cat: b2bCategory(it.cat, s?.product_type),
      photo: abs(it.photo || s?.image_link || ""),
      url: s?.slug ? `${SITE_URL}/product/${s.slug}/${id}.html` : null,
      mpn: s?.mpn || null,
      usd: usd > 0 ? usd : null,
      // Як feed/opt.xml: round(wholesale_usd × usd_rate, 2); без гурту - ціна за запитом.
      price: usd > 0 ? Math.round(usd * rate * 100) / 100 : null,
      // РРЦ - роздрібна ціна сайту (як у prom_file.xml до націнок).
      rrp: Number(p.price) || parseFloat(s?.price) || null,
      // Як <available> у фідах: не вимкнено в адмінці і є на сайті (або товар лише для фідів).
      available: !p.off && (p.in_stock === true || !s),
    });
  }
  cache = { at: Date.now(), items };
  return items;
}

async function specialPrices(clientId: string) {
  const { data } = await db.from("b2b_special_prices").select("product_id, price").eq("client_id", clientId);
  return Object.fromEntries((data ?? []).map((r) => [r.product_id, Number(r.price)]));
}

// ─── Хто викликає ───────────────────────────────────────────────────────

async function caller(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data } = await db.auth.getUser(token);
  return data?.user ?? null;
}

async function isAdmin(userId: string) {
  const { data } = await db.from("tg_admins").select("user_id").eq("user_id", userId).maybeSingle();
  return !!data;
}

const CLIENT_FIELDS = ["id", "status", "company", "edrpou", "contact_name", "phone", "email", "city"];

async function createLogin(email: string, password: string) {
  const { data, error } = await db.auth.admin.createUser({
    email, password, email_confirm: true, app_metadata: { role: "b2b" },
  });
  if (error) {
    // Не перетворюємо наявного користувача (напр. адміна) на B2B-клієнта.
    if (/already|exists|registered/i.test(error.message)) throw new Error("Користувач з таким email уже є в Supabase Auth");
    throw new Error(error.message);
  }
  return data.user.id;
}

function clientInput(b: any) {
  return {
    company: text(b.company, 200),
    edrpou: text(b.edrpou, 20),
    contact_name: text(b.contact_name, 100),
    phone: text(b.phone, 40),
    email: text(b.email, 200)?.toLowerCase() ?? null,
    city: text(b.city, 120),
  };
}

// ─── Дії ────────────────────────────────────────────────────────────────

async function apply(b: any) {
  if (text(b.website, 100)) return json({ ok: true }); // пастка для ботів
  const c = clientInput(b);
  if (!c.company || !c.contact_name) return json({ error: "Заповніть назву компанії і контактну особу" }, 400);
  if ((normalizePhone(c.phone ?? "")?.length ?? 0) < 10) return json({ error: "Вкажіть телефон повністю, напр. +380 67 123 45 67" }, 400);
  if (!isEmail(c.email)) return json({ error: "Перевірте email" }, 400);
  const { data: same } = await db.from("b2b_clients").select("id, status").eq("email", c.email!).limit(1);
  if (same?.length) {
    return json({ ok: true, already: true, status: same[0].status });
  }
  const { data: row, error } = await db.from("b2b_clients")
    .insert({ ...c, comment: text(b.comment, 2000) }).select("id").single();
  if (error) { console.error("b2b: apply", error); return json({ error: "save failed" }, 500); }
  await notifyManager([
    `🏢 <b>Нова заявка B2B</b>`,
    `${escHtml(c.company)}${c.edrpou ? `, ЄДРПОУ ${escHtml(c.edrpou)}` : ""}`,
    `${escHtml(c.contact_name)}, ${escHtml(c.phone)}, ${escHtml(c.email)}`,
    c.city ? escHtml(c.city) : "",
    b.comment ? `Коментар: ${escHtml(text(b.comment, 500))}` : "",
    `\n<a href="${SITE_URL}/b2b-admin/#${row.id}">Відкрити в адмінці</a>`,
  ]);
  return json({ ok: true });
}

async function order(client: any, b: any) {
  const raw = Array.isArray(b.items) ? b.items.slice(0, MAX_ITEMS) : [];
  const byId = new Map((await catalog()).map((i) => [i.id, i]));
  const special = await specialPrices(client.id);
  const items = raw.map((r: any) => ({ it: byId.get(String(r?.id ?? "")), qty: Math.min(9999, Math.max(1, Math.round(Number(r?.qty) || 1))) }))
    .filter((r: any) => r.it)
    .map((r: any, n: number) => ({
      position: n, product_id: r.it.id, title: r.it.name, sku: r.it.code, qty: r.qty, price: special[r.it.id] ?? r.it.price,
    }));
  if (!items.length) return json({ error: "no items" }, 400);

  const clientKey = text(b.client_key, 80);
  if (clientKey) {
    const { data: dup } = await db.from("orders").select("number").eq("client_key", clientKey).maybeSingle();
    if (dup) return json({ ok: true, number: dup.number, duplicate: true });
  }
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count } = await db.from("orders").select("id", { count: "exact", head: true })
    .eq("b2b_client_id", client.id).gte("created_at", since);
  if ((count ?? 0) >= 10) return json({ error: "too many orders" }, 429);

  const total = items.reduce((s: number, i: any) => s + (i.price ?? 0) * i.qty, 0);
  const { data: o, error } = await db.from("orders").insert({
    client_key: clientKey,
    source: "B2B",
    b2b_client_id: client.id,
    name: [client.contact_name, client.company].filter(Boolean).join(" · "),
    phone: client.phone,
    phone_norm: normalizePhone(client.phone ?? ""),
    city: text(b.city, 120) ?? client.city,
    np_branch: text(b.np_branch, 200),
    payment_method: text(b.payment_method, 80),
    comment: text(b.comment, 2000),
    page_url: `${SITE_URL}/b2b/`,
    total: Math.round(total * 100) / 100,
  }).select("*").single();
  if (error) {
    if (error.code === "23505" && clientKey) {
      const { data: dup } = await db.from("orders").select("number").eq("client_key", clientKey).maybeSingle();
      if (dup) return json({ ok: true, number: dup.number, duplicate: true });
    }
    console.error("b2b: order", error);
    return json({ error: "save failed" }, 500);
  }
  const { error: itemsError } = await db.from("order_items").insert(items.map((i: any) => ({ ...i, order_id: o.id })));
  if (itemsError) console.error("b2b: items", itemsError);

  // Оплата балами: перевірки (баланс, частка суми, блокування від подвійного списання) - у affiliate_spend.
  let pointsSpent = 0;
  let pointsError: string | null = null;
  const points = Math.floor(Number(b.points) || 0);
  if (points > 0 && !itemsError && client.affiliate_enabled === true) {
    const { data: aff } = await db.from("affiliates").select("id").eq("client_id", client.id).maybeSingle();
    const { data: spent, error } = aff
      ? await db.rpc("affiliate_spend", { p_affiliate: aff.id, p_order: o.id, p_points: points })
      : { data: 0, error: { message: "not a partner" } };
    if (error) {
      pointsError = /not enough/.test(error.message) ? "Недостатньо балів"
        : /too many points/.test(error.message) ? "Балами можна оплатити лише частину суми" : error.message;
      console.error("b2b: points", error);
    } else pointsSpent = spent ?? 0;
  }
  const { data: pv } = pointsSpent ? await db.from("affiliate_settings").select("point_value").eq("id", 1).single() : { data: null };
  const pointsUah = pointsSpent * (Number(pv?.point_value) || 1);

  await notifyManager([
    `🏢 <b>B2B замовлення №${o.number}</b> · ${escHtml(client.company)}`,
    `${escHtml(client.contact_name)}, ${escHtml(client.phone)}`,
    [o.city, o.np_branch].filter(Boolean).map(escHtml).join(", "),
    o.payment_method ? `Оплата: ${escHtml(o.payment_method)}` : "",
    "",
    ...items.map((i: any) => `• [${escHtml(i.sku)}] ${escHtml(i.title)} × ${i.qty}${i.price != null ? ` - ${money(i.price * i.qty)}` : " - ціна за запитом"}`),
    total > 0 ? `<b>Разом: ${money(total)}</b>` : "",
    pointsSpent ? `🎁 Оплачено балами: ${pointsSpent} (−${money(pointsUah)}), до оплати: <b>${money(total - pointsUah)}</b>` : "",
    o.comment ? `\nКоментар: ${escHtml(o.comment)}` : "",
    `\n<a href="${SITE_URL}/orders-admin/#${o.number}">Відкрити в адмінці</a>`,
  ]);
  await background(sendToSheet({
    name: [client.contact_name, client.company].filter(Boolean).join(" · "),
    phone: client.phone ?? "",
    city: o.city ?? "",
    npBranch: o.np_branch ?? "",
    paymentMethod: o.payment_method ?? "",
    // № замовлення з адмінки - у коментарі (своя колонка «№ замовлення» в таблиці - час заявки).
    comment: [`B2B №${o.number}`, client.edrpou ? `ЄДРПОУ ${client.edrpou}` : "",
      pointsSpent ? `оплачено балами ${pointsSpent} (−${money(pointsUah)})` : "", o.comment ?? ""].filter(Boolean).join(" · "),
    source: "B2B",
  }, items));
  return json({ ok: true, number: o.number, points_spent: pointsSpent, points_error: pointsError });
}

async function admin(action: string, b: any) {
  if (action === "admin_list") {
    const { data, error } = await db.from("b2b_clients").select("*").order("created_at", { ascending: false });
    if (error) return json({ error: error.message }, 500);
    const { data: counts } = await db.from("orders").select("b2b_client_id, total").not("b2b_client_id", "is", null);
    const stats: Record<string, { orders: number; total: number }> = {};
    for (const o of counts ?? []) {
      const s = (stats[o.b2b_client_id] ??= { orders: 0, total: 0 });
      s.orders++; s.total += Number(o.total) || 0;
    }
    return json({ ok: true, clients: (data ?? []).map((c) => ({ ...c, ...(stats[c.id] ?? { orders: 0, total: 0 }) })) });
  }

  if (action === "admin_create") {
    const c = clientInput(b);
    if (!c.company || !isEmail(c.email)) return json({ error: "Вкажіть назву компанії і email" }, 400);
    const { data: same } = await db.from("b2b_clients").select("id").eq("email", c.email!).limit(1);
    if (same?.length) return json({ error: "Клієнт з таким email уже є в списку" }, 400);
    const password = text(b.password, 72) ?? genPassword();
    if (password.length < 8) return json({ error: "Пароль - щонайменше 8 символів" }, 400);
    let userId: string;
    try { userId = await createLogin(c.email!, password); } catch (e) { return json({ error: (e as Error).message }, 400); }
    const { error } = await db.from("b2b_clients").insert({
      ...c, user_id: userId, status: "approved", approved_at: new Date().toISOString(), manager_note: text(b.manager_note, 2000),
    });
    if (error) { await db.auth.admin.deleteUser(userId); return json({ error: error.message }, 500); }
    return json({ ok: true, email: c.email, password });
  }

  const { data: c } = await db.from("b2b_clients").select("*").eq("id", text(b.id, 40) ?? "").maybeSingle();
  if (!c) return json({ error: "not found" }, 404);

  if (action === "admin_approve") {
    const password = text(b.password, 72) ?? genPassword();
    if (password.length < 8) return json({ error: "Пароль - щонайменше 8 символів" }, 400);
    if (c.user_id) {
      await db.auth.admin.updateUserById(c.user_id, { password, ban_duration: "none" });
    } else {
      try { c.user_id = await createLogin(c.email, password); } catch (e) { return json({ error: (e as Error).message }, 400); }
    }
    const { error } = await db.from("b2b_clients").update({
      user_id: c.user_id, status: "approved", approved_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", c.id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, email: c.email, password });
  }

  if (action === "admin_special_get") {
    return json({ ok: true, items: await catalog(), special: await specialPrices(c.id) });
  }

  if (action === "admin_special_set") {
    const known = new Set((await catalog()).map((i) => i.id));
    const set: { client_id: string; product_id: string; price: number; updated_at: string }[] = [];
    const del: string[] = [];
    for (const [id, v] of Object.entries(b.prices ?? {})) {
      if (!known.has(id)) continue;
      const n = Math.round(Number(v) * 100) / 100;
      if (v === null || v === "" || !(n > 0)) del.push(id);
      else set.push({ client_id: c.id, product_id: id, price: n, updated_at: new Date().toISOString() });
    }
    if (set.length) {
      const { error } = await db.from("b2b_special_prices").upsert(set);
      if (error) return json({ error: error.message }, 500);
    }
    if (del.length) {
      const { error } = await db.from("b2b_special_prices").delete().eq("client_id", c.id).in("product_id", del);
      if (error) return json({ error: error.message }, 500);
    }
    return json({ ok: true, special: await specialPrices(c.id) });
  }

  if (action === "admin_update") {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const k of ["company", "edrpou", "contact_name", "phone", "city"] as const) {
      if (k in b) patch[k] = text(b[k], k === "company" ? 200 : 120);
    }
    if ("manager_note" in b) patch.manager_note = text(b.manager_note, 2000);
    if (typeof b.affiliate_enabled === "boolean") patch.affiliate_enabled = b.affiliate_enabled;
    if (b.status) {
      if (!["pending", "approved", "rejected", "blocked"].includes(b.status)) return json({ error: "bad status" }, 400);
      if (b.status === "approved" && !c.user_id) return json({ error: "Спершу схваліть заявку - створиться вхід" }, 400);
      patch.status = b.status;
    }
    let password: string | null = null;
    if (b.password) {
      if (!c.user_id) return json({ error: "У клієнта ще немає входу" }, 400);
      password = text(b.password, 72);
      if (!password || password.length < 8) return json({ error: "Пароль - щонайменше 8 символів" }, 400);
      const { error } = await db.auth.admin.updateUserById(c.user_id, { password });
      if (error) return json({ error: error.message }, 400);
    }
    // Заблокований не може навіть увійти; повернули статус - вхід знову працює.
    if (c.user_id && b.status && b.status !== c.status) {
      await db.auth.admin.updateUserById(c.user_id, { ban_duration: b.status === "approved" ? "none" : "876000h" });
    }
    const { error } = await db.from("b2b_clients").update(patch).eq("id", c.id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, password });
  }

  return json({ error: "unknown action" }, 400);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const action = String(b?.action ?? "");

  try {
    if (action === "apply") return await apply(b);

    const user = await caller(req);
    if (!user) return json({ error: "not signed in" }, 401);

    if (action.startsWith("admin_")) {
      if (!(await isAdmin(user.id))) return json({ error: "not allowed" }, 403);
      return await admin(action, b);
    }

    if (user.app_metadata?.role !== "b2b") return json({ error: "not a b2b client" }, 403);
    // select("*"): поки не виконано SQL з колонкою affiliate_enabled, кабінет працює (вкладка просто прихована).
    const { data: client } = await db.from("b2b_clients").select("*").eq("user_id", user.id).maybeSingle();
    if (!client) return json({ error: "not a b2b client" }, 403);
    if (action === "me") {
      return json({ ok: true, client: { ...Object.fromEntries(CLIENT_FIELDS.map((k) => [k, client[k]])), affiliate_enabled: client.affiliate_enabled === true } });
    }
    if (client.status !== "approved") return json({ error: "not approved", status: client.status }, 403);

    if (action === "catalog") {
      const [items, special, { data: favs }] = await Promise.all([
        catalog(), specialPrices(client.id),
        db.from("b2b_favorites").select("product_id").eq("client_id", client.id),
      ]);
      return json({ ok: true, items, cats: B2B_CATEGORIES, rate: usdRate, special, favorites: (favs ?? []).map((f) => f.product_id) });
    }
    if (action === "fav") {
      const id = text(b.id, 40);
      if (!id) return json({ error: "no id" }, 400);
      const { error } = b.on
        ? await db.from("b2b_favorites").upsert({ client_id: client.id, product_id: id })
        : await db.from("b2b_favorites").delete().eq("client_id", client.id).eq("product_id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (action === "order") return await order(client, b);
    if (action === "orders") {
      const { data, error } = await db.from("orders")
        .select("number, created_at, status, total, affiliate_points_spent, city, np_branch, comment, ttn, order_items(title, sku, qty, price, position)")
        .eq("b2b_client_id", client.id).order("created_at", { ascending: false }).limit(100);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, orders: data });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error("b2b:", action, e);
    return json({ error: "server error" }, 500);
  }
});
