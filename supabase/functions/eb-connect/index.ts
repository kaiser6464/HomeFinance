// Authenticated: list banks, or start a bank authorisation for the household
import { createClient } from "npm:@supabase/supabase-js@2";
import { admin, cors, eb, json, CALLBACK_URL, PROJECT_URL, setting } from "./eb.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const userClient = createClient(PROJECT_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Not signed in" }, 401);
    const db = admin();
    const { data: me } = await db.from("members").select("household_id").eq("user_id", user.id).single();
    if (!me) return json({ error: "Finish setup first" }, 400);

    const body = await req.json().catch(() => ({}));

    if (body.action === "status") {
      const appId = Deno.env.get("EB_APP_ID") || (await setting(db, "eb_app_id"));
      return json({ app_id_set: !!appId, key_set: !!Deno.env.get("EB_PRIVATE_KEY"), callback_url: CALLBACK_URL });
    }

    if (body.action === "banks") {
      const r = await eb(db, `/aspsps?country=${encodeURIComponent(body.country || "GB")}&psu_type=personal`);
      const banks = (r.aspsps || []).map((a: any) => ({ name: a.name, country: a.country, logo: a.logo, max_days: a.maximum_consent_validity ? Math.floor(a.maximum_consent_validity / 86400) : 90 }));
      return json({ banks });
    }

    if (body.action === "start") {
      const { bank, country = "GB", owner } = body; // owner: member user_id or 'joint'
      if (!bank) return json({ error: "Choose a bank" }, 400);
      let ownerId: string | null = null;
      if (owner && owner !== "joint") {
        const { data: m } = await db.from("members").select("user_id").eq("user_id", owner).eq("household_id", me.household_id).single();
        if (!m) return json({ error: "Unknown owner" }, 400);
        ownerId = m.user_id;
      }
      const r = await eb(db, `/aspsps?country=${encodeURIComponent(country)}&psu_type=personal`);
      const aspsp = (r.aspsps || []).find((a: any) => a.name === bank);
      const maxSecs = aspsp?.maximum_consent_validity || 90 * 86400;
      const validUntil = new Date(Date.now() + Math.min(maxSecs, 180 * 86400) * 1000 - 3600_000).toISOString();
      const state = crypto.randomUUID();
      const { error } = await db.from("bank_connections").insert({
        household_id: me.household_id, created_by: user.id, aspsp_name: bank, aspsp_country: country,
        owner_label: owner === "joint" ? "joint" : "member", owner_user_id: ownerId, pending_state: state, status: "pending",
      });
      if (error) throw error;
      const auth = await eb(db, "/auth", {
        method: "POST",
        body: JSON.stringify({
          access: { valid_until: validUntil },
          aspsp: { name: bank, country },
          state, redirect_url: CALLBACK_URL, psu_type: "personal",
        }),
      });
      return json({ url: auth.url });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
