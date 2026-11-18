// Admin only. POST {action: "list"} | {action: "invite", email, name} | {action: "remove", user_id}
// Invite makes an account with a one-time password; the friend must change it at first login.
import { caller, cors, json, serviceClient } from "./_shared/core.ts";

const tempPassword = () => {
  const a = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(14));
  return Array.from(b, (x) => a[x % a.length]).join("");
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "Use POST" }, 405);
  const me = await caller(req);
  if (!me) return json(req, { error: "Please log in" }, 401);
  const svc = serviceClient();
  const { data: admin } = await svc.from("pw_members").select("is_admin").eq("user_id", me.id).maybeSingle();
  if (!admin?.is_admin) return json(req, { error: "Only the owner can do this" }, 403);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json(req, { error: "Bad request" }, 400); }

  if (b.action === "list") {
    const { data } = await svc.from("pw_members").select("user_id, email, display_name, is_admin, must_change_password, created_at").order("created_at");
    return json(req, data ?? []);
  }
  if (b.action === "invite") {
    const email = String(b.email ?? "").trim().toLowerCase();
    const name = String(b.name ?? "").trim().slice(0, 60) || null;
    if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/.test(email)) return json(req, { error: "That email address does not look right" }, 400);
    const { count } = await svc.from("pw_members").select("*", { count: "exact", head: true });
    if ((count ?? 0) >= 25) return json(req, { error: "Up to 25 people can use Price Watch" }, 400);
    const pw = tempPassword();
    let uid: string | null = null;
    const created = await svc.auth.admin.createUser({ email, password: pw, email_confirm: true });
    if (created.error) {
      // Already has an account in this project (for example from another app): give them a new one-time password.
      const { data: list } = await svc.auth.admin.listUsers({ perPage: 1000 });
      const u = list?.users.find((x) => (x.email ?? "").toLowerCase() === email);
      if (!u) return json(req, { error: "Could not make the account" }, 500);
      if (u.id === me.id) return json(req, { error: "That is you" }, 400);
      const { data: existing } = await svc.from("pw_members").select("user_id").eq("user_id", u.id).maybeSingle();
      if (existing) return json(req, { error: "That person is already invited" }, 400);
      return json(req, { error: "That email already has an account in this project. Ask Claude to add it." }, 400);
    } else uid = created.data.user!.id;
    const { error } = await svc.from("pw_members").insert({ user_id: uid, email, display_name: name, must_change_password: true });
    if (error) { await svc.auth.admin.deleteUser(uid!); return json(req, { error: "Could not add them" }, 500); }
    return json(req, { email, temp_password: pw });
  }
  if (b.action === "remove") {
    const uid = String(b.user_id ?? "");
    if (uid === me.id) return json(req, { error: "You cannot remove yourself" }, 400);
    const { data: m } = await svc.from("pw_members").select("user_id").eq("user_id", uid).maybeSingle();
    if (!m) return json(req, { error: "Not found" }, 404);
    const { error } = await svc.auth.admin.deleteUser(uid);   // their items go too (cascade)
    if (error) return json(req, { error: "Could not remove them" }, 500);
    return json(req, { ok: true });
  }
  return json(req, { error: "Unknown action" }, 400);
});
