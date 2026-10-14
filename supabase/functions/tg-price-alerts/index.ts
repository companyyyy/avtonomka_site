// tg-price-alerts - пише в Telegram тим, хто натиснув у мініаппі «Повідомити
// про зниження ціни» (tg_price_watch, scripts/supabase/price_watch_schema.sql),
// якщо ціна на сайті стала нижчою за ref_price щонайменше на MIN_DROP.
// Після сповіщення ref_price = нова ціна: про наступне зниження теж напишемо,
// а коливання вгору ігноруємо.
//
// Викликає .github/workflows/update.yml після викладки нових цін на сервер
// (POST без тіла). Ціни бере з живого products.json сайту, а не з запиту,
// тож зайвий виклик нічого не ламає - просто ще раз звіряє ціни.
// Перед надсиланням рядок «займається» (ref_price оновлюється умовно), тож
// два одночасні виклики не напишуть людині двічі.
//
// Секрети: TELEGRAM_BOT_TOKEN; необов'язково SITE_URL, MINIAPP_URL.
// JWT-перевірку вимкнути (Enforce JWT verification = off).

import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TG_API = Deno.env.get("TELEGRAM_API_BASE") ?? "https://api.telegram.org"; // для тестів
const SITE_URL = (Deno.env.get("SITE_URL") ?? "https://avtonomka.com.ua").replace(/\/$/, "");
const MINIAPP_URL = Deno.env.get("MINIAPP_URL") ?? `${SITE_URL}/miniapp_v/index.html`;
const MIN_DROP = 0.01; // 1%: копійчані коливання ціни постачальника не розсилаємо
const SEND_GAP_MS = 50;

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const escHtml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const uah = (n: number) => `${Math.round(n).toLocaleString("uk-UA")} грн`;

async function tg(method: string, payload: unknown) {
  const res = await fetch(`${TG_API}/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await res.json() as { ok: boolean; error_code?: number; description?: string; parameters?: { retry_after?: number } };
}

export function sitePrice(raw: unknown): number | null {
  const n = parseFloat(String(raw ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function isDrop(ref: number, price: number) {
  return price <= ref * (1 - MIN_DROP);
}

export function alertMessage(productId: string, name: string, oldPrice: number, newPrice: number) {
  return {
    text: [
      "🔔 <b>Ціна знизилась!</b>",
      "",
      `<b>${escHtml(name)}</b>`,
      `Було: <s>${uah(oldPrice)}</s>`,
      `Зараз: <b>${uah(newPrice)}</b> (−${uah(oldPrice - newPrice)})`,
      "",
      "Щоб не отримувати сповіщення про цей товар, відкрийте його й натисніть «скасувати».",
    ].join("\n"),
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "Переглянути товар", web_app: { url: `${MINIAPP_URL}?startapp=product_${productId}` } }]],
    },
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!BOT_TOKEN) return new Response("TELEGRAM_BOT_TOKEN не задано", { status: 500 });

  const res = await fetch(`${SITE_URL}/products.json?t=${Date.now()}`);
  if (!res.ok) return new Response(`products.json: HTTP ${res.status}`, { status: 502 });
  const list = await res.json();
  const products = new Map<string, { title: string; price: number | null }>();
  for (const p of Array.isArray(list) ? list : list.products ?? []) {
    products.set(String(p.id), { title: p.title, price: sitePrice(p.price) });
  }

  const { data: watches, error } = await db
    .from("tg_price_watch")
    .select("tg_id, product_id, product_name, ref_price, tg_users(bot_blocked)");
  if (error) return new Response(error.message, { status: 500 });

  const counts = { checked: watches?.length ?? 0, sent: 0, failed: 0, blocked: 0 };
  for (const w of watches ?? []) {
    if ((w as any).tg_users?.bot_blocked) continue;
    const p = products.get(w.product_id);
    const ref = Number(w.ref_price);
    if (!p?.price || !isDrop(ref, p.price)) continue;

    // «Займаємо» сповіщення: лише якщо ref_price ще не змінив паралельний виклик.
    const { data: claimed } = await db.from("tg_price_watch")
      .update({ ref_price: p.price, last_notified_at: new Date().toISOString() })
      .eq("tg_id", w.tg_id).eq("product_id", w.product_id).eq("ref_price", w.ref_price)
      .select("tg_id");
    if (!claimed?.length) continue;

    const name = p.title || w.product_name || w.product_id;
    let r = await tg("sendMessage", { chat_id: w.tg_id, ...alertMessage(w.product_id, name, ref, p.price) });
    if (!r.ok && r.error_code === 429) {
      await sleep(((r.parameters?.retry_after ?? 1) + 1) * 1000);
      r = await tg("sendMessage", { chat_id: w.tg_id, ...alertMessage(w.product_id, name, ref, p.price) });
    }
    if (r.ok) {
      counts.sent++;
      await db.from("tg_events").insert({ tg_id: w.tg_id, event: "price_alert", product_id: w.product_id, product_name: name });
    } else if (r.error_code === 403) {
      counts.blocked++;
      await db.from("tg_users").update({ bot_blocked: true }).eq("tg_id", w.tg_id);
    } else {
      // Не дійшло - повертаємо стару ціну, щоб спробувати при наступному виклику.
      counts.failed++;
      console.error("tg-price-alerts:", w.tg_id, w.product_id, r.description);
      await db.from("tg_price_watch").update({ ref_price: ref })
        .eq("tg_id", w.tg_id).eq("product_id", w.product_id);
    }
    await sleep(SEND_GAP_MS);
  }

  return new Response(JSON.stringify(counts), { headers: { "Content-Type": "application/json" } });
});
