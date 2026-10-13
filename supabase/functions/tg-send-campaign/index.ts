// tg-send-campaign - надсилає розсилку (tg_campaigns) ботом. Викликає розділ
// «Розсилка» адмінки (miniapp-mailing.html) від імені залогіненого адміна.
//
// Запит: POST, заголовок Authorization: Bearer <JWT адміна> (supabase-js
// functions.invoke додає його сам), тіло:
//   { ping: true }                         - чи підключено бота (getMe)
//   { campaign_id, test_tg_id }            - тестове повідомлення одній людині
//   { campaign_id }                        - надіслати / продовжити надсилання
//
// Отримувачів фіксує SQL-функція tg_prepare_campaign (лише ті, кому можна
// писати). Надсилає ~20 повідомлень за секунду (ліміт Telegram - 30), за
// один виклик - до ~100 с; що не встигло, лишається 'pending', і адмінка
// викликає функцію ще раз.
//
// Секрети: TELEGRAM_BOT_TOKEN; необов'язково MINIAPP_URL, SITE_URL.
// SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY Supabase додає сам.
// Інструкція - docs/TELEGRAM_BOT_SETUP.md.

import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TG_API = Deno.env.get("TELEGRAM_API_BASE") ?? "https://api.telegram.org"; // для тестів
const SITE_URL = (Deno.env.get("SITE_URL") ?? "https://avtonomka.com.ua").replace(/\/$/, "");
const MINIAPP_URL = Deno.env.get("MINIAPP_URL") ?? `${SITE_URL}/miniapp_v/index.html`;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const TIME_BUDGET_MS = 100_000;
const SEND_GAP_MS = 50;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tg(method: string, payload: unknown) {
  const res = await fetch(`${TG_API}/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await res.json() as { ok: boolean; result?: any; error_code?: number; description?: string; parameters?: { retry_after?: number } };
}

type Product = { id: string; title: string; price?: string; image_link?: string };

async function loadProduct(id: string | null): Promise<Product | null> {
  if (!id) return null;
  try {
    const res = await fetch(`${SITE_URL}/products.json?t=${Date.now()}`);
    const list = await res.json() as Product[];
    return list.find((p) => p.id === id) ?? null;
  } catch {
    return null;
  }
}

const fmtPrice = (raw?: string) => {
  const n = parseFloat(String(raw ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? `${Math.round(n).toLocaleString("uk-UA")} грн` : "";
};

// {ім'я} {товар} {ціна} у тексті розсилки
export function renderMessage(template: string, firstName: string | null, product: Product | null, fallbackName: string | null) {
  return template
    .replaceAll("{ім'я}", (firstName ?? "").trim())
    .replaceAll("{товар}", product?.title ?? fallbackName ?? "")
    .replaceAll("{ціна}", fmtPrice(product?.price))
    .replace(/ +([,!.])/g, "$1") // "Вітаю , ..." коли ім'я порожнє
    .trim();
}

export function buildMessage(campaign: any, product: Product | null, firstName: string | null) {
  const text = renderMessage(campaign.message, firstName, product, campaign.product_name);
  const start = campaign.product_id ? `product_${campaign.product_id}_c${campaign.id}` : `open_c${campaign.id}`;
  const reply_markup = {
    inline_keyboard: [
      [{ text: campaign.button_text || "Переглянути товар", web_app: { url: `${MINIAPP_URL}?startapp=${start}` } }],
    ],
  };
  const photo = product?.image_link
    ? (/^https?:\/\//.test(product.image_link) ? product.image_link : `${SITE_URL}/${product.image_link.replace(/^\//, "")}`)
    : null;
  // Підпис до фото - максимум 1024 символи; довший текст - окремим повідомленням без фото.
  if (photo && text.length <= 1024) return { method: "sendPhoto", payload: { photo, caption: text, reply_markup } };
  return { method: "sendMessage", payload: { text, reply_markup } };
}

async function sendOne(chatId: number, msg: { method: string; payload: Record<string, unknown> }) {
  let r = await tg(msg.method, { chat_id: chatId, ...msg.payload });
  if (!r.ok && r.error_code === 429) {
    await sleep(((r.parameters?.retry_after ?? 1) + 1) * 1000);
    r = await tg(msg.method, { chat_id: chatId, ...msg.payload });
  }
  // Фото не завантажилось (немає доступу до файлу тощо) - пробуємо текстом.
  if (!r.ok && msg.method === "sendPhoto" && r.error_code === 400) {
    r = await tg("sendMessage", {
      chat_id: chatId, text: msg.payload.caption, reply_markup: msg.payload.reply_markup,
    });
  }
  return r;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // Хто викликає - адмін зі списку tg_admins (перевіряє SQL is_tg_admin()).
  const auth = req.headers.get("Authorization") ?? "";
  const asUser = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data: isAdmin } = await asUser.rpc("is_tg_admin");
  if (isAdmin !== true) return json({ error: "not allowed" }, 403);

  const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  let body: { ping?: boolean; campaign_id?: number; test_tg_id?: number };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  if (!BOT_TOKEN) return json({ error: "TELEGRAM_BOT_TOKEN не задано в Secrets" }, 500);

  if (body.ping) {
    const me = await tg("getMe", {});
    return me.ok ? json({ ok: true, bot: me.result.username }) : json({ error: me.description }, 502);
  }

  const { data: campaign } = await db.from("tg_campaigns").select("*").eq("id", body.campaign_id).single();
  if (!campaign) return json({ error: "кампанію не знайдено" }, 404);
  const product = await loadProduct(campaign.product_id);

  // Тест: одне повідомлення, нічого не записуємо.
  if (body.test_tg_id) {
    const { data: u } = await db.from("tg_users").select("first_name").eq("tg_id", body.test_tg_id).single();
    const r = await sendOne(body.test_tg_id, buildMessage(campaign, product, u?.first_name ?? null));
    return r.ok ? json({ ok: true }) : json({ error: r.description }, 502);
  }

  if (campaign.status === "sent" || campaign.status === "cancelled") {
    return json({ error: `кампанія вже ${campaign.status === "sent" ? "надіслана" : "скасована"}` }, 409);
  }
  if (campaign.status === "draft") {
    const { error } = await asUser.rpc("tg_prepare_campaign", { p_campaign_id: campaign.id });
    if (error) return json({ error: error.message }, 400);
  }

  const { data: pending } = await db
    .from("tg_campaign_recipients")
    .select("tg_id, tg_users(first_name)")
    .eq("campaign_id", campaign.id)
    .eq("status", "pending");

  const started = Date.now();
  const counts = { sent: 0, failed: 0, blocked: 0 };
  let left = (pending ?? []).length;
  for (const r of pending ?? []) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    const firstName = (r as any).tg_users?.first_name ?? null;
    const res = await sendOne(r.tg_id, buildMessage(campaign, product, firstName));
    const now = new Date().toISOString();
    if (res.ok) {
      counts.sent++;
      await db.from("tg_campaign_recipients").update({ status: "sent", sent_at: now })
        .eq("campaign_id", campaign.id).eq("tg_id", r.tg_id);
      await db.from("tg_users").update({ last_message_at: now }).eq("tg_id", r.tg_id);
    } else if (res.error_code === 403) {
      counts.blocked++;
      await db.from("tg_campaign_recipients").update({ status: "blocked", error: res.description })
        .eq("campaign_id", campaign.id).eq("tg_id", r.tg_id);
      await db.from("tg_users").update({ bot_blocked: true }).eq("tg_id", r.tg_id);
    } else {
      counts.failed++;
      await db.from("tg_campaign_recipients").update({ status: "failed", error: res.description ?? "помилка" })
        .eq("campaign_id", campaign.id).eq("tg_id", r.tg_id);
    }
    left--;
    await sleep(SEND_GAP_MS);
  }

  if (left === 0) {
    await db.from("tg_campaigns").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", campaign.id);
  }
  return json({ ok: true, ...counts, remaining: left });
});
