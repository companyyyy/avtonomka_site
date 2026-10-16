// order-submit - приймає замовлення з сайту (кошик checkout.js, швидка заявка
// order-form.js) і з мініаппа (miniapp_v/index.html), зберігає їх у таблиці
// orders / order_items (scripts/supabase/orders_schema.sql) і пише менеджеру
// в Telegram. Перегляд і обробка - розділ «Замовлення» адмінки (orders-admin/).
//
// Запит: POST JSON {
//   client_key,            // випадковий ключ замовлення з браузера (повтор не створює дубль)
//   source,                // "Кошик" | "Швидка заявка" | "Мініапп"
//   name, phone, city?, np_branch?, payment_method?, comment?, page_url?,
//   items: [{ product_id?, title, sku?, qty, price? }],
//   initData?              // мініапп: підписані дані Telegram - звідти tg_id клієнта
// }
// Відповідь: { ok: true, number } або { error } зі статусом 4xx/5xx.
//
// Сайт паралельно шле те саме в Google Таблицю (запасна копія), тож якщо ця
// функція недоступна, замовлення не губиться.
//
// Секрети (Edge Functions → Secrets) - ті самі, що для бота: TELEGRAM_BOT_TOKEN,
// MANAGER_CHAT_ID (без нього замовлення зберігаються, але сповіщень немає).
// SUPABASE_URL і SUPABASE_SERVICE_ROLE_KEY Supabase додає сам.
// JWT-перевірку вимкнути (Enforce JWT verification = off): сайт без сесії Supabase.
// Інструкція - docs/ORDERS.md.

import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const MANAGER_CHAT_ID = Deno.env.get("MANAGER_CHAT_ID") ?? "";
const TG_API = Deno.env.get("TELEGRAM_API_BASE") ?? "https://api.telegram.org";
const SITE_URL = (Deno.env.get("SITE_URL") ?? "https://avtonomka.com.ua").replace(/\/$/, "");
const SOURCES = ["Кошик", "Швидка заявка", "Мініапп"];
const MAX_ITEMS = 50;
// Не більше стількох замовлень з одного телефону за 10 хвилин (захист від спаму).
const PHONE_LIMIT = 5;

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

// "+38 (067) 123-45-67" / "067 1234567" -> "380671234567" (як normalize_phone у SQL)
export function normalizePhone(p: string) {
  const d = (p ?? "").replace(/\D/g, "");
  if (/^380\d{9}$/.test(d)) return d;
  if (/^80\d{9}$/.test(d)) return "3" + d;
  if (/^0\d{9}$/.test(d)) return "38" + d;
  return d || null;
}

const enc = new TextEncoder();
async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

// Як verifyInitData у miniapp-api: користувач Telegram лише з підписаних даних.
async function telegramUser(initData: string) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !BOT_TOKEN) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join("\n");
  const expected = hex(await hmac(await hmac(enc.encode("WebAppData"), BOT_TOKEN), dataCheck));
  if (expected !== hash) return null;
  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > 24 * 60 * 60) return null;
  try {
    const user = JSON.parse(params.get("user") ?? "null");
    return user?.id ? user : null;
  } catch {
    return null;
  }
}

export function cleanItems(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_ITEMS).map((i: any, n: number) => {
    const qty = Math.min(9999, Math.max(1, Math.round(Number(i?.qty) || 1)));
    const price = Number(String(i?.price ?? "").replace(/\s/g, "").replace(",", "."));
    return {
      position: n,
      product_id: text(i?.product_id ?? i?.id, 60),
      title: text(i?.title ?? i?.name, 300),
      sku: text(i?.sku, 60),
      qty,
      price: Number.isFinite(price) && price >= 0 && price < 1e9 ? Math.round(price * 100) / 100 : null,
    };
  }).filter((i) => i.title);
}

const escHtml = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (n: number) => `${Math.round(n).toLocaleString("uk-UA")} грн`;

async function notifyManager(order: any, items: any[]) {
  if (!MANAGER_CHAT_ID || !BOT_TOKEN) return;
  const who = order.tg_username ? ` (@${escHtml(order.tg_username)})` : order.tg_id ? ` (<a href="tg://user?id=${order.tg_id}">Telegram</a>)` : "";
  const lines = [
    `🛒 <b>Нове замовлення №${order.number}</b> · ${escHtml(order.source)}`,
    `${escHtml(order.name)}, ${escHtml(order.phone)}${who}`,
    [order.city, order.np_branch].filter(Boolean).map(escHtml).join(", "),
    order.payment_method ? `Оплата: ${escHtml(order.payment_method)}` : "",
    "",
    ...items.map((i) => `• ${escHtml(i.title)} × ${i.qty}${i.price != null ? ` - ${money(i.price * i.qty)}` : ""}`),
    order.total > 0 ? `<b>Разом: ${money(order.total)}</b>` : "",
    order.comment ? `\nКоментар: ${escHtml(order.comment)}` : "",
    `\n<a href="${SITE_URL}/orders-admin/#${order.number}">Відкрити в адмінці</a>`,
  ].filter((l) => l !== "");
  try {
    await fetch(`${TG_API}/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: MANAGER_CHAT_ID, text: lines.join("\n"), parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch (e) {
    console.error("order-submit: Telegram", e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const name = text(b.name, 100);
  const phone = text(b.phone, 40);
  const phoneNorm = normalizePhone(phone ?? "");
  if (!name || !phoneNorm || phoneNorm.length < 7) return json({ error: "name and phone required" }, 400);
  const source = SOURCES.includes(b.source) ? b.source : "Кошик";
  const items = cleanItems(b.items);
  if (!items.length) return json({ error: "no items" }, 400);
  const clientKey = text(b.client_key, 80);

  // Той самий ключ уже прийнято (повторне надсилання) - повертаємо той самий номер.
  if (clientKey) {
    const { data: dup } = await db.from("orders").select("number").eq("client_key", clientKey).maybeSingle();
    if (dup) return json({ ok: true, number: dup.number, duplicate: true });
  }

  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count } = await db.from("orders").select("id", { count: "exact", head: true })
    .eq("phone_norm", phoneNorm).gte("created_at", since);
  if ((count ?? 0) >= PHONE_LIMIT) return json({ error: "too many orders" }, 429);

  const tg = b.initData ? await telegramUser(String(b.initData)) : null;
  const total = items.reduce((s, i) => s + (i.price ?? 0) * i.qty, 0);

  const { data: order, error } = await db.from("orders").insert({
    client_key: clientKey,
    source,
    name,
    phone,
    phone_norm: phoneNorm,
    city: text(b.city, 120),
    np_branch: text(b.np_branch, 200),
    payment_method: text(b.payment_method, 80),
    comment: text(b.comment, 2000),
    page_url: text(b.page_url, 500),
    tg_id: tg?.id ?? null,
    tg_username: tg?.username ?? null,
    total: Math.round(total * 100) / 100,
  }).select("*").single();

  if (error) {
    // Два однакові запити одночасно - другий упирається в унікальний client_key.
    if (error.code === "23505" && clientKey) {
      const { data: dup } = await db.from("orders").select("number").eq("client_key", clientKey).maybeSingle();
      if (dup) return json({ ok: true, number: dup.number, duplicate: true });
    }
    console.error("order-submit: insert", error);
    return json({ error: "save failed" }, 500);
  }

  const { error: itemsError } = await db.from("order_items").insert(items.map((i) => ({ ...i, order_id: order.id })));
  if (itemsError) console.error("order-submit: items", itemsError);

  await notifyManager(order, items);
  return json({ ok: true, number: order.number });
});
