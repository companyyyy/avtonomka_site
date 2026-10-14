// miniapp-api - вхід для мініаппа (miniapp_v/index.html) з перевіркою, що
// дані справді прийшли від Telegram: підпис initData перевіряється токеном
// бота, і id клієнта береться з підписаних даних, а не з запиту.
//
// Запит: POST { initData, fn, args }
//   fn = "visit" | "track" | "like" | "write_access" | "price_watch" | "price_watches"
// Далі викликає ті самі SQL-функції (scripts/supabase/miniapp_tracking_schema.sql)
// ключем service_role.
//
// Сповіщення менеджеру: коли клієнт утретє повертається до товару (візит =
// відкриття картки не раніше ніж через 30 хв після попереднього, за 30 днів),
// бот пише в MANAGER_CHAT_ID - хто, який товар, чи в кошику/обраному, чи
// можна йому робити розсилку. По кожній парі клієнт+товар - один раз
// (саме на 3-му візиті).
//
// Секрети (Edge Functions → Secrets): TELEGRAM_BOT_TOKEN; необов'язково
// MANAGER_CHAT_ID (без нього сповіщень немає).
// SUPABASE_URL і SUPABASE_SERVICE_ROLE_KEY Supabase додає сам.
// JWT-перевірку для цієї функції вимкнути (Enforce JWT verification = off):
// мініапп не має сесії Supabase, захист - підпис Telegram.
// Повна інструкція - docs/TELEGRAM_BOT_SETUP.md.

import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const MAX_AGE_SEC = 24 * 60 * 60; // initData старші за добу не приймаємо
const MANAGER_CHAT_ID = Deno.env.get("MANAGER_CHAT_ID") ?? "";
const TG_API = Deno.env.get("TELEGRAM_API_BASE") ?? "https://api.telegram.org"; // для тестів
const SITE_URL = (Deno.env.get("SITE_URL") ?? "https://avtonomka.com.ua").replace(/\/$/, "");
const INTEREST_VISITS = 3;
const VISIT_GAP_MS = 30 * 60 * 1000;
const INTEREST_DAYS = 30;

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

const enc = new TextEncoder();
async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export async function verifyInitData(initData: string, botToken: string, maxAgeSec = MAX_AGE_SEC) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !botToken) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  const expected = hex(await hmac(secret, dataCheck));
  if (expected.length !== hash.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ hash.charCodeAt(i);
  if (diff !== 0) return null;
  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;
  const user = JSON.parse(params.get("user") ?? "null");
  if (!user?.id) return null;
  return { user, startParam: params.get("start_param") };
}

const str = (v: unknown, max = 300) => (typeof v === "string" ? v.slice(0, max) : null);

const escHtml = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Ціни з products.json сайту, кеш на годину (живе, поки живий інстанс функції)
let pricesCache: { at: number; map: Map<string, string> } | null = null;
async function productPrice(productId: string): Promise<string> {
  try {
    if (!pricesCache || Date.now() - pricesCache.at > 60 * 60 * 1000) {
      const res = await fetch(`${SITE_URL}/products.json`);
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.products ?? []);
      pricesCache = { at: Date.now(), map: new Map(list.map((p: any) => [String(p.id), String(p.price ?? "")])) };
    }
    const raw = pricesCache.map.get(productId) ?? "";
    const n = parseFloat(raw.replace(/\s/g, "").replace(",", "."));
    return isNaN(n) ? "" : `${n.toLocaleString("uk-UA")} ₴`;
  } catch {
    return "";
  }
}

// Скільки окремих візитів (з паузою ≥ 30 хв) клієнт зробив на товар і чи
// щойно записаний перегляд почав новий візит.
export function countVisits(times: number[], gapMs = VISIT_GAP_MS) {
  let visits = 0;
  let newVisit = false;
  for (let i = 0; i < times.length; i++) {
    newVisit = i === 0 || times[i] - times[i - 1] >= gapMs;
    if (newVisit) visits++;
  }
  return { visits, newVisit };
}

async function notifyInterest(tgId: number, productId: string | null, productName: string | null) {
  if (!MANAGER_CHAT_ID || !productId || String(tgId) === MANAGER_CHAT_ID) return;

  const since = new Date(Date.now() - INTEREST_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: opens } = await db.from("tg_events").select("created_at")
    .eq("tg_id", tgId).eq("product_id", productId).eq("event", "product_open")
    .gte("created_at", since).order("created_at", { ascending: true }).limit(500);
  const { visits, newVisit } = countVisits((opens ?? []).map((r: any) => Date.parse(r.created_at)));
  if (!newVisit || visits !== INTEREST_VISITS) return;

  const [user, like, other, price] = await Promise.all([
    db.from("tg_users").select("username, first_name, last_name, write_access, opted_out, bot_blocked")
      .eq("tg_id", tgId).maybeSingle(),
    db.from("tg_likes").select("tg_id").eq("tg_id", tgId).eq("product_id", productId).maybeSingle(),
    db.from("tg_events").select("event").eq("tg_id", tgId).eq("product_id", productId)
      .in("event", ["cart_add", "order"]),
    productPrice(productId),
  ]);
  const u: any = user.data ?? {};
  const events = (other.data ?? []).map((r: any) => r.event);
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || "Без імені";
  const canMessage = u.write_access === true && !u.opted_out && !u.bot_blocked;
  const whyNot = u.bot_blocked ? "заблокував бота" : u.opted_out ? "відписався" : "не дав дозволу писати";

  const lines = [
    `👀 <a href="tg://user?id=${tgId}">${escHtml(name)}</a>${u.username ? ` (@${escHtml(u.username)})` : ""} утретє дивиться товар`,
    `<b>${escHtml(productName ?? productId)}</b>${price ? ` · ${escHtml(price)}` : ""}`,
    [
      events.includes("order") ? "✅ уже замовляв" : events.includes("cart_add") ? "🛒 у кошику" : "",
      like.data ? "❤️ в обраному" : "",
    ].filter(Boolean).join(" · "),
    canMessage ? "📨 можна надіслати розсилку" : `🚫 розсилку не отримає (${whyNot})`,
    `<a href="${SITE_URL}/miniapp-admin.html">Відкрити в адмінці</a>`,
  ].filter(Boolean);

  await fetch(`${TG_API}/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: MANAGER_CHAT_ID, text: lines.join("\n"), parse_mode: "HTML", disable_web_page_preview: true }),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: { initData?: string; fn?: string; args?: Record<string, unknown> };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const v = await verifyInitData(body.initData ?? "", BOT_TOKEN);
  if (!v) return json({ error: "invalid initData" }, 401);
  const tgId = v.user.id;
  const a = body.args ?? {};

  let res;
  switch (body.fn) {
    case "visit":
      res = await db.rpc("miniapp_visit", {
        p_user: v.user,
        p_platform: str(a.p_platform, 32),
        // кнопка web_app з розсилки передає параметр в адресі, а не в initData
        p_start_param: v.startParam ?? str(a.p_start_param, 128),
      });
      break;
    case "track":
      res = await db.rpc("miniapp_track", {
        p_tg_id: tgId,
        p_event: str(a.p_event, 32),
        p_product_id: str(a.p_product_id, 32),
        p_product_name: str(a.p_product_name),
        p_category: str(a.p_category, 128),
        p_query: str(a.p_query, 200),
      });
      if (!res.error && a.p_event === "product_open") {
        // Сповіщення не має ламати запис перегляду
        try {
          await notifyInterest(tgId, str(a.p_product_id, 32), str(a.p_product_name));
        } catch (e) {
          console.error("notifyInterest:", e);
        }
      }
      break;
    case "like":
      res = await db.rpc("miniapp_set_like", {
        p_tg_id: tgId,
        p_product_id: str(a.p_product_id, 32),
        p_product_name: str(a.p_product_name),
        p_liked: a.p_liked === true,
      });
      break;
    case "write_access":
      res = await db.rpc("miniapp_set_write_access", { p_tg_id: tgId, p_allowed: a.p_allowed === true });
      break;
    case "price_watch":
      res = await db.rpc("miniapp_set_price_watch", {
        p_tg_id: tgId,
        p_product_id: str(a.p_product_id, 32),
        p_product_name: str(a.p_product_name),
        p_price: typeof a.p_price === "number" && a.p_price > 0 ? a.p_price : null,
        p_on: a.p_on === true,
      });
      break;
    case "price_watches":
      res = await db.rpc("miniapp_price_watches", { p_tg_id: tgId });
      break;
    default:
      return json({ error: "unknown fn" }, 400);
  }
  if (res.error) return json({ error: res.error.message }, 400);
  return json(res.data ?? null);
});
