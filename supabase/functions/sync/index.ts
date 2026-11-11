// Starling connect + sync, called by the app (signed-in) or the schedule (x-cron-secret)
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const STARLING = "https://api.starlingbank.com/api/v2";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const admin = () => createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

async function starling(token: string, path: string) {
  const r = await fetch(`${STARLING}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!r.ok) {
    const t = await r.text();
    const e = new Error(r.status === 401 || r.status === 403
      ? "Starling rejected the token. Check it has the read permissions and hasn't been revoked."
      : `Starling ${r.status}: ${t.slice(0, 200)}`) as Error & { status: number };
    e.status = r.status; throw e;
  }
  return r.json();
}

async function syncStarling(db: SupabaseClient, conn: any, initial: boolean) {
  const { data: token } = await db.rpc("svc_get_token", { p_conn: conn.id });
  if (!token) throw new Error("No Starling token saved");
  const { data: accounts } = await db.from("accounts").select("*").eq("connection_id", conn.id);
  let total = 0;
  for (const a of accounts || []) {
    const [accountUid, categoryUid] = String(a.eb_account_uid).split(":");
    try {
      const b = await starling(token as string, `/accounts/${accountUid}/balance`);
      const bal = (b.effectiveBalance ?? b.clearedBalance)?.minorUnits;
      if (bal != null) await db.from("accounts").update({ balance: bal / 100, balance_at: new Date().toISOString() }).eq("id", a.id);
    } catch (e) { console.warn("balance", (e as Error).message); }

    const sinceDays = initial || !conn.last_synced_at ? 730
      : Math.min(730, Math.ceil((Date.now() - new Date(conn.last_synced_at).getTime()) / 86400000) + 10);
    const rows: any[] = [];
    // Starling limits each request window; walk in 90-day chunks
    for (let end = Date.now(); end > Date.now() - sinceDays * 86400000; end -= 90 * 86400000) {
      const start = Math.max(end - 90 * 86400000, Date.now() - sinceDays * 86400000);
      const q = `minTransactionTimestamp=${new Date(start).toISOString()}&maxTransactionTimestamp=${new Date(end).toISOString()}`;
      const f = await starling(token as string, `/feed/account/${accountUid}/category/${categoryUid}/transactions-between?${q}`);
      for (const it of f.feedItems || []) {
        if (["DECLINED", "REVERSED", "REFUNDED_UPCOMING", "UPCOMING", "UPCOMING_CANCELLED", "RETRYING"].includes(it.status)) continue;
        const minor = it.amount?.minorUnits ?? 0;
        const amount = (it.direction === "OUT" ? -1 : 1) * minor / 100;
        const isTransfer = it.source === "INTERNAL_TRANSFER" || it.spendingCategory === "SAVING" || it.counterPartyType === "CATEGORY";
        rows.push({
          household_id: a.household_id, account_id: a.id, eb_ref: `st:${it.feedItemUid}`,
          booking_date: (it.settlementTime || it.transactionTime).slice(0, 10), amount,
          currency: it.amount?.currency || "GBP", merchant: it.counterPartyName || null,
          description: [it.reference, it.spendingCategory?.replace(/_/g, " ").toLowerCase()].filter(Boolean).join(" · ") || null,
          status: it.status === "PENDING" ? "pending" : "booked", is_transfer: isTransfer,
        });
      }
    }
    // Pending items are refreshed each run; settled ones keep the same id so they don't duplicate
    await db.from("transactions").delete().eq("account_id", a.id).eq("status", "pending");
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from("transactions").upsert(rows.slice(i, i + 500), { onConflict: "account_id,eb_ref", ignoreDuplicates: true });
      if (error) throw error;
    }
    total += rows.length;
  }
  return total;
}

async function runConnection(db: SupabaseClient, conn: any, initial = false) {
  try {
    const n = await syncStarling(db, conn, initial);
    await db.from("bank_connections").update({ last_synced_at: new Date().toISOString(), last_error: null, status: "active" }).eq("id", conn.id);
    return { bank: conn.aspsp_name, fetched: n };
  } catch (e) {
    const err = e as Error & { status?: number };
    await db.from("bank_connections").update({ last_error: err.message.slice(0, 500), status: err.status === 401 || err.status === 403 ? "expired" : "error" }).eq("id", conn.id);
    return { bank: conn.aspsp_name, error: err.message };
  } finally {
    await db.rpc("categorise_household", { p_household: conn.household_id, p_only_uncategorised: true });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = admin();
  const body = await req.json().catch(() => ({}));

  // Scheduled run
  const secret = req.headers.get("x-cron-secret");
  if (secret) {
    const { data: s } = await db.rpc("svc_get_setting", { p_key: "cron_secret" });
    if (secret !== s) return json({ error: "Forbidden" }, 403);
    const { data: conns } = await db.from("bank_connections").select("*").in("status", ["active", "error"]);
    const results = [];
    for (const c of conns || []) results.push(await runConnection(db, c));
    return json({ ok: true, results });
  }

  // Signed-in user
  const uc = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
  const { data: { user } } = await uc.auth.getUser();
  if (!user) return json({ error: "Please sign in again." }, 401);
  const { data: me } = await db.from("members").select("household_id").eq("user_id", user.id).single();
  if (!me) return json({ error: "Finish setting up your household first." }, 400);

  try {
    if (body.action === "connect_starling") {
      const token = String(body.token || "").trim();
      if (token.length < 20) return json({ error: "That doesn't look like a Starling access token." }, 400);
      let ownerId: string | null = null;
      if (body.owner && body.owner !== "joint") {
        const { data: m } = await db.from("members").select("user_id").eq("user_id", body.owner).eq("household_id", me.household_id).single();
        ownerId = m?.user_id ?? null;
      }
      const acc = await starling(token, "/accounts");
      if (!acc.accounts?.length) return json({ error: "Starling returned no accounts for that token." }, 400);
      const { data: conn, error } = await db.from("bank_connections").insert({
        household_id: me.household_id, created_by: user.id, aspsp_name: "Starling", provider: "starling",
        owner_label: body.owner === "joint" ? "joint" : "member", owner_user_id: ownerId, status: "active",
      }).select().single();
      if (error) throw error;
      await db.rpc("svc_save_token", { p_conn: conn.id, p_token: token });
      for (const a of acc.accounts) {
        const uid = `${a.accountUid}:${a.defaultCategory}`;
        await db.from("accounts").upsert({
          household_id: me.household_id, connection_id: conn.id, eb_account_uid: uid, source: "starling", provider: "Starling",
          name: a.name || `Starling ${String(a.accountType || "").toLowerCase()}`, account_type: "current", currency: a.currency || "GBP",
          owner_user_id: body.owner === "joint" ? null : ownerId, is_joint: body.owner === "joint",
        }, { onConflict: "eb_account_uid" });
      }
      const result = await runConnection(db, conn, true);
      return json({ ok: true, accounts: acc.accounts.length, ...result });
    }

    if (body.action === "sync_now") {
      const { data: conns } = await db.from("bank_connections").select("*").eq("household_id", me.household_id).in("status", ["active", "error"]);
      const results = [];
      for (const c of conns || []) results.push(await runConnection(db, c));
      return json({ ok: true, results });
    }

    if (body.action === "update_token") {
      const { data: c } = await db.from("bank_connections").select("*").eq("id", body.connection_id).eq("household_id", me.household_id).single();
      if (!c) return json({ error: "Connection not found" }, 404);
      await starling(String(body.token).trim(), "/accounts");
      await db.rpc("svc_save_token", { p_conn: c.id, p_token: String(body.token).trim() });
      return json(await runConnection(db, { ...c, status: "active" }));
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
