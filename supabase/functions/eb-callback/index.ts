// Public: the bank sends the user back here after they approve access
import { admin, eb, setting, storeAccounts, syncConnection } from "./eb.ts";

function page(title: string, msg: string, appUrl: string | null) {
  const back = appUrl ? `<p><a href="${appUrl}" style="color:#0f766e;font-weight:600">Back to Household Money →</a></p>` : "<p>You can close this tab and go back to the app.</p>";
  return new Response(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 20px;color:#1c1917;background:#faf7f2">
<h1 style="font-size:22px">${title}</h1><p>${msg}</p>${back}</body>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

Deno.serve(async (req) => {
  const db = admin();
  const appUrl = await setting(db, "app_url");
  const u = new URL(req.url);
  const state = u.searchParams.get("state");
  const code = u.searchParams.get("code");
  const err = u.searchParams.get("error_description") || u.searchParams.get("error");
  if (!state) return page("Something went wrong", "The bank didn't send back a reference. Please try connecting again.", appUrl);

  const { data: conn } = await db.from("bank_connections").select("*").eq("pending_state", state).single();
  if (!conn) return page("Link expired", "This connection link has already been used or has expired. Please start again from the app.", appUrl);
  if (err || !code) {
    await db.from("bank_connections").delete().eq("id", conn.id);
    return page("Bank connection cancelled", `Nothing was connected${err ? ` (${String(err).slice(0, 120)})` : ""}.`, appUrl);
  }

  try {
    const s = await eb(db, "/sessions", { method: "POST", body: JSON.stringify({ code }) });
    await db.from("bank_connections").update({
      eb_session_id: s.session_id, status: "active", pending_state: null,
      valid_until: s.access?.valid_until || null, last_error: null,
    }).eq("id", conn.id);
    const fresh = { ...conn, eb_session_id: s.session_id };
    await storeAccounts(db, fresh, s.accounts || []);
    // Pull history in the background so the user isn't left waiting
    // @ts-ignore EdgeRuntime is provided by Supabase
    EdgeRuntime.waitUntil(syncConnection(db, fresh, true));
    const n = (s.accounts || []).length;
    return page(`${conn.aspsp_name} connected`, `${n} account${n === 1 ? "" : "s"} linked. Transactions are downloading now — give it a minute, then refresh the app.`, appUrl);
  } catch (e) {
    await db.from("bank_connections").update({ status: "error", last_error: (e as Error).message.slice(0, 500), pending_state: null }).eq("id", conn.id);
    return page("Couldn't finish connecting", (e as Error).message.replace(/</g, "&lt;"), appUrl);
  }
});
