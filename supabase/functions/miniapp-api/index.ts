// miniapp-api - вхід для мініаппа (miniapp_v/index.html) з перевіркою, що
// дані справді прийшли від Telegram: підпис initData перевіряється токеном
// бота, і id клієнта береться з підписаних даних, а не з запиту.
//
// Запит: POST { initData, fn, args }
//   fn = "visit" | "track" | "like" | "write_access"
// Далі викликає ті самі SQL-функції (scripts/supabase/miniapp_tracking_schema.sql)
// ключем service_role.
//
// Секрети (Edge Functions → Secrets): TELEGRAM_BOT_TOKEN.
// SUPABASE_URL і SUPABASE_SERVICE_ROLE_KEY Supabase додає сам.
// JWT-перевірку для цієї функції вимкнути (Enforce JWT verification = off):
// мініапп не має сесії Supabase, захист - підпис Telegram.
// Повна інструкція - docs/TELEGRAM_BOT_SETUP.md.

import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const MAX_AGE_SEC = 24 * 60 * 60; // initData старші за добу не приймаємо

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
    default:
      return json({ error: "unknown fn" }, 400);
  }
  if (res.error) return json({ error: res.error.message }, 400);
  return json(res.data ?? null);
});
