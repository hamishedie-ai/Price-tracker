// Called by pg_cron every 30 minutes with a secret header (its hash is in private.pw_cron).
// 1) Sends the price-drop emails that the home-server checker queued in pw_alerts.
// 2) Backup: if the home server has not checked in for 2 hours, check up to 10 due items here (plain fetch).
import { checkItem, Item, sendDropEmail, serviceClient } from "./_shared/core.ts";

Deno.serve(async (req) => {
  const svc = serviceClient();
  const { data: ok } = await svc.rpc("pw_cron_secret_ok", { p: req.headers.get("x-cron-secret") ?? "" });
  if (ok !== true) return new Response("no", { status: 401 });
  let sent = 0, checked = 0, failed = 0;

  const { data: alerts } = await svc.from("pw_alerts").select("id, item_id, old_price, new_price")
    .is("sent_at", null).order("created_at").limit(30);
  for (const a of alerts ?? []) {
    const { data: it } = await svc.from("pw_items").select("*").eq("id", a.item_id).maybeSingle();
    const { data: m } = it ? await svc.from("pw_members").select("email, alerts_on").eq("user_id", it.user_id).maybeSingle() : { data: null };
    try {
      if (it && m?.alerts_on) { await sendDropEmail(m.email, { ...it, price: a.new_price } as Item, Number(a.old_price)); sent++; }
      await svc.from("pw_alerts").update({ sent_at: new Date().toISOString() }).eq("id", a.id);
    } catch (e) { failed++; console.error("email", a.id, e); }
  }

  const { data: seen } = await svc.rpc("pw_worker_last_seen");
  if (!seen || Date.now() - Date.parse(seen as string) > 2 * 3600_000) {
    const due = new Date(Date.now() - 6 * 3600_000).toISOString();
    const { data: items } = await svc.from("pw_items").select("*")
      .or(`last_checked.is.null,last_checked.lt.${due}`).order("last_checked", { ascending: true, nullsFirst: true }).limit(10);
    for (const it of (items ?? []) as Item[]) {
      try {
        const old = it.price == null ? null : Number(it.price);
        const { item, drop } = await checkItem(svc, it);
        checked++;
        if (drop && old != null) {
          const { data: m } = await svc.from("pw_members").select("email, alerts_on").eq("user_id", it.user_id).maybeSingle();
          if (m?.alerts_on) await sendDropEmail(m.email, item, old).catch((e) => console.error("email", e));
        }
      } catch (e) { failed++; console.error("check", it.id, e); }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return new Response(JSON.stringify({ sent, checked, failed, worker_last_seen: seen }), { headers: { "Content-Type": "application/json" } });
});
