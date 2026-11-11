// Runs from the schedule (x-cron-secret) or from the app's "Sync now" button (signed-in user)
import { createClient } from "npm:@supabase/supabase-js@2";
import { admin, cors, json, PROJECT_URL, setting, syncConnection } from "./eb.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = admin();
  let householdId: string | null = null;

  const secret = req.headers.get("x-cron-secret");
  if (secret) {
    if (secret !== (await setting(db, "cron_secret"))) return json({ error: "Forbidden" }, 403);
  } else {
    const userClient = createClient(PROJECT_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Not signed in" }, 401);
    const { data: m } = await db.from("members").select("household_id").eq("user_id", user.id).single();
    if (!m) return json({ error: "Not in a household" }, 400);
    householdId = m.household_id;
  }

  // Mark lapsed authorisations
  await db.from("bank_connections").update({ status: "expired" }).lt("valid_until", new Date().toISOString()).eq("status", "active");
  // Tidy abandoned connection attempts
  await db.from("bank_connections").delete().eq("status", "pending").lt("created_at", new Date(Date.now() - 86400000).toISOString());

  let q = db.from("bank_connections").select("*").in("status", ["active", "error"]);
  if (householdId) q = q.eq("household_id", householdId);
  const { data: conns } = await q;

  const results: any[] = [];
  for (const c of conns || []) {
    const n = await syncConnection(db, c);
    results.push({ bank: c.aspsp_name, fetched: n });
  }
  return json({ ok: true, results });
});
