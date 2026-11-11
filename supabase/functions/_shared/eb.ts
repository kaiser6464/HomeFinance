// Shared Enable Banking + Supabase helpers
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { importPKCS8, SignJWT } from "npm:jose@5";

export const EB_API = "https://api.enablebanking.com";
export const PROJECT_URL = Deno.env.get("SUPABASE_URL")!;
export const CALLBACK_URL = `${PROJECT_URL}/functions/v1/eb-callback`;

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

export function admin(): SupabaseClient {
  return createClient(PROJECT_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
}

export async function setting(db: SupabaseClient, key: string): Promise<string | null> {
  const { data } = await db.rpc("svc_get_setting", { p_key: key });
  return (data as string) ?? null;
}

let cachedJwt: { token: string; exp: number } | null = null;

async function ebJwt(db: SupabaseClient): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && cachedJwt.exp - 60 > now) return cachedJwt.token;
  const appId = Deno.env.get("EB_APP_ID") || (await setting(db, "eb_app_id"));
  let pem = Deno.env.get("EB_PRIVATE_KEY");
  if (!appId) throw new Error("Enable Banking application ID is not set yet.");
  if (!pem) throw new Error("EB_PRIVATE_KEY secret is not set yet in Supabase Edge Function secrets.");
  pem = pem.includes("BEGIN") ? pem.replace(/\\n/g, "\n") : atob(pem); // allow raw PEM, \n-escaped, or base64
  if (pem.includes("BEGIN RSA PRIVATE KEY")) throw new Error("Key is PKCS#1; convert with: openssl pkcs8 -topk8 -nocrypt -in key.pem");
  const key = await importPKCS8(pem.trim(), "RS256");
  const exp = now + 3600;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: appId })
    .setIssuer("enablebanking.com").setAudience("api.enablebanking.com")
    .setIssuedAt(now).setExpirationTime(exp).sign(key);
  cachedJwt = { token, exp };
  return token;
}

export async function eb(db: SupabaseClient, path: string, init: RequestInit = {}) {
  const res = await fetch(`${EB_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await ebJwt(db)}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let body: any; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const msg = typeof body === "object" ? (body.message || body.error || JSON.stringify(body)) : body;
    const err = new Error(`Enable Banking ${res.status}: ${msg}`) as Error & { status: number };
    err.status = res.status; throw err;
  }
  return body;
}

function accountType(a: any): string {
  const t = (a.cash_account_type || "").toUpperCase();
  const name = `${a.name || ""} ${a.product || ""} ${a.details || ""}`.toLowerCase();
  if (t === "CARD" || /credit|card|amex|platinum|cashback/.test(name)) return "credit_card";
  if (t === "SVGS" || /saver|savings|isa/.test(name)) return "savings";
  if (t === "CACC" || t === "TRAN" || /current|everyday/.test(name)) return "current";
  return "other";
}

export async function storeAccounts(db: SupabaseClient, conn: any, accounts: any[]) {
  for (const a of accounts) {
    const type = accountType(a);
    const label = a.name || a.product || a.details || `${conn.aspsp_name} ${type.replace("_", " ")}`;
    const last4 = (a.account_id?.iban || a.account_id?.other?.identification || "").slice(-4);
    await db.from("accounts").upsert({
      household_id: conn.household_id, connection_id: conn.id, eb_account_uid: a.uid,
      name: last4 ? `${label} ••${last4}` : label, account_type: type, currency: a.currency || "GBP",
      owner_user_id: conn.owner_label === "joint" ? null : conn.owner_user_id,
      is_joint: conn.owner_label === "joint",
    }, { onConflict: "eb_account_uid", ignoreDuplicates: false });
  }
}

async function digest(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export async function syncAccount(db: SupabaseClient, account: any, sinceDays: number) {
  // Balance
  try {
    const bal = await eb(db, `/accounts/${account.eb_account_uid}/balances`);
    const pick = (bal.balances || []).find((b: any) => ["ITAV", "CLAV", "ITBD", "CLBD", "XPCD", "ITAV"].includes(b.balance_type)) || bal.balances?.[0];
    if (pick) {
      let amt = Number(pick.balance_amount.amount);
      if (account.account_type === "credit_card" && amt > 0 && pick.credit_debit_indicator !== "CRDT") amt = -amt;
      await db.from("accounts").update({ balance: amt, balance_at: new Date().toISOString() }).eq("id", account.id);
    }
  } catch (e) { console.warn("balance", account.id, (e as Error).message); }

  // Transactions
  const from = new Date(Date.now() - sinceDays * 86400000);
  let cont: string | null = null; const rows: any[] = []; const seen = new Map<string, number>(); let pages = 0;
  do {
    const q = new URLSearchParams({ date_from: isoDate(from) });
    if (cont) q.set("continuation_key", cont);
    const page = await eb(db, `/accounts/${account.eb_account_uid}/transactions?${q}`);
    for (const t of page.transactions || []) {
      const out = t.credit_debit_indicator === "DBIT";
      const amount = Math.abs(Number(t.transaction_amount?.amount || 0)) * (out ? -1 : 1);
      const counterparty = out ? t.creditor?.name : t.debtor?.name;
      const desc = [...(t.remittance_information || []), t.note].filter(Boolean).join(" · ") || t.bank_transaction_code?.description || "";
      const date = t.booking_date || t.transaction_date || t.value_date || isoDate(new Date());
      const pending = t.status === "PDNG";
      let ref = t.entry_reference || t.transaction_id;
      if (!ref) {
        const base = await digest(`${date}|${amount}|${counterparty}|${desc}|${pending}`);
        const n = (seen.get(base) || 0) + 1; seen.set(base, n); ref = `h:${base}:${n}`;
      }
      if (pending) ref = `p:${ref}`;
      rows.push({
        household_id: account.household_id, account_id: account.id, eb_ref: ref, booking_date: date, amount,
        currency: t.transaction_amount?.currency || "GBP", merchant: counterparty || null,
        description: desc || null, status: pending ? "pending" : "booked",
      });
    }
    cont = page.continuation_key || null;
  } while (cont && ++pages < 50);

  // Pending items get replaced each sync so they don't duplicate once booked
  await db.from("transactions").delete().eq("account_id", account.id).eq("status", "pending");
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("transactions").upsert(rows.slice(i, i + 500), { onConflict: "account_id,eb_ref", ignoreDuplicates: true });
    if (error) throw error;
  }
  return rows.length;
}

export async function syncConnection(db: SupabaseClient, conn: any, initial = false) {
  const { data: accounts } = await db.from("accounts").select("*").eq("connection_id", conn.id);
  let total = 0;
  try {
    for (const a of accounts || []) {
      const days = initial || !conn.last_synced_at ? 730
        : Math.min(730, Math.ceil((Date.now() - new Date(conn.last_synced_at).getTime()) / 86400000) + 10);
      total += await syncAccount(db, a, days);
    }
    await db.from("bank_connections").update({ last_synced_at: new Date().toISOString(), last_error: null, status: "active" }).eq("id", conn.id);
  } catch (e) {
    const err = e as Error & { status?: number };
    const expired = err.status === 401 || /expired|EXPIRED_SESSION|revoked|consent/i.test(err.message);
    await db.from("bank_connections").update({ last_error: err.message.slice(0, 500), status: expired ? "expired" : "error" }).eq("id", conn.id);
  }
  await db.rpc("categorise_household", { p_household: conn.household_id, p_only_uncategorised: true });
  return total;
}
