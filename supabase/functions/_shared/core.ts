// Shared server code for Price Watch Edge Functions.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";
import { parse } from "./extract.ts";

export const SITE_URL = Deno.env.get("PW_SITE_URL") ?? "https://hamishedie-ai.github.io/Price-tracker/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

export const cors = (req: Request) => {
  const origin = req.headers.get("origin") ?? "";
  const allowed = ["https://hamishedie-ai.github.io"];
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
};

export function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
}

export function serviceClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

/** The signed-in caller, or null. Uses the caller's own token, so it cannot be faked. */
export async function caller(req: Request): Promise<{ id: string; email?: string } | null> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const { data, error } = await serviceClient().auth.getUser(auth.slice(7));
  return error || !data.user ? null : { id: data.user.id, email: data.user.email ?? undefined };
}

/** Public http(s) pages only (no IP addresses, no local names). */
export function allowedUrl(raw: string): string {
  const url = new URL(String(raw).trim());
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Paste a full link that starts with https://");
  if (url.username || url.password) throw new Error("Links with a username or password are not allowed");
  const h = url.hostname.toLowerCase();
  if (!h.includes(".") || h.endsWith(".local") || h.endsWith(".internal") || /^[\d.]+$/.test(h) || h.includes(":")) {
    throw new Error("That link is not a public website");
  }
  return url.toString();
}

export async function fetchPage(url: string): Promise<string> {
  let target = allowedUrl(url);
  for (let hop = 0; hop < 5; hop++) {
    const r = await fetch(target, {
      redirect: "manual",
      headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-AU,en;q=0.9" },
      signal: AbortSignal.timeout(20000),
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      target = allowedUrl(new URL(r.headers.get("location")!, target).toString());
      await r.body?.cancel();
      continue;
    }
    if (!r.ok) throw new Error(`The shop answered ${r.status}`);
    const reader = r.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < 6_000_000) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.length;
    }
    await reader.cancel().catch(() => {});
    const buf = new Uint8Array(size);
    let o = 0;
    for (const c of chunks) { buf.set(c.subarray(0, Math.min(c.length, size - o)), o); o += c.length; if (o >= size) break; }
    return new TextDecoder().decode(buf);
  }
  throw new Error("Too many redirects");
}

export type Item = {
  id: number; user_id: string; url: string; title: string | null; image: string | null; currency: string | null;
  price: number | null; first_price: number | null; lowest: number | null; target: number | null;
  in_stock: boolean | null; last_checked: string | null; last_error: string | null;
};

export function money(p: number | null, cur: string | null) {
  if (p == null) return "no price";
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: cur ?? "AUD", currencyDisplay: "narrowSymbol" }).format(p);
}

/** Read the page, save the new price, and return the item plus any price drop. */
export async function checkItem(svc: SupabaseClient, it: Item): Promise<{ item: Item; drop: number | null }> {
  let info = null as ReturnType<typeof parse> | null;
  let err: string | null = null;
  try {
    info = parse(await fetchPage(it.url));
    if (info.price == null) err = "No price found on this page (the shop may block price checkers)";
  } catch (e) {
    err = `Could not read the page: ${(e as Error).message}`.slice(0, 200);
  }
  const p = info?.price ?? null;
  const upd: Record<string, unknown> = { last_checked: new Date().toISOString(), last_error: err };
  if (info?.title) upd.title = info.title;
  if (info?.image) upd.image = info.image;
  if (info?.currency) upd.currency = info.currency;
  if (info && info.in_stock != null) upd.in_stock = info.in_stock;
  if (p != null) {
    upd.price = p;
    upd.lowest = it.lowest == null ? p : Math.min(it.lowest, p);
    if (it.first_price == null) upd.first_price = p;
  }
  const { data, error } = await svc.from("pw_items").update(upd).eq("id", it.id).select().single();
  if (error) throw error;
  if (p != null && (it.price == null || Math.abs(p - Number(it.price)) >= 0.005)) {
    await svc.from("pw_history").insert({ item_id: it.id, price: p });
  }
  const drop = p != null && it.price != null && p < Number(it.price) - 0.005 ? Number(it.price) - p : null;
  return { item: data as Item, drop };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function sendDropEmail(to: string, it: Item, oldPrice: number) {
  const user = Deno.env.get("GMAIL_USER"), pass = Deno.env.get("GMAIL_APP_PASSWORD");
  if (!user || !pass) throw new Error("Email is not set up (GMAIL_USER, GMAIL_APP_PASSWORD)");
  const hit = it.target != null && it.price != null && Number(it.price) <= Number(it.target);
  const name = it.title ?? it.url;
  const subject = `${hit ? "Target price hit" : "Price drop"}: ${name}`.slice(0, 150);
  const line = `Now ${money(it.price, it.currency)}, was ${money(oldPrice, it.currency)}.`;
  const client = new SMTPClient({ connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: user, password: pass } } });
  try {
    await client.send({
      from: `Price Watch <${user}>`, to, subject,
      content: `${name}\n${line}\n\nOpen the shop: ${it.url}\nYour list: ${SITE_URL}`,
      html: `<p><b>${esc(name)}</b><br>${esc(line)}</p><p><a href="${esc(it.url)}">Open the shop</a> · <a href="${esc(SITE_URL)}">Your Price Watch list</a></p>`,
    });
  } finally { await client.close(); }
}
