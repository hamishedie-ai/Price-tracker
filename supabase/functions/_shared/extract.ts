// Find a product's name, image, price and stock state in a web page (JSON-LD first, then meta tags).
export type Product = {
  title: string | null; image: string | null; price: number | null; currency: string | null; in_stock: boolean | null;
};

const LD_RE = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
const META_RE = /<meta\s+[^>]*>/gi;
const ATTR_RE = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

function num(v: unknown): number | null {
  if (v == null || typeof v === "boolean") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const m = String(v).match(/\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function* walk(o: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(o)) { for (const x of o) yield* walk(x); }
  else if (o && typeof o === "object") {
    const d = o as Record<string, unknown>;
    yield d;
    for (const v of Object.values(d)) if (v && typeof v === "object") yield* walk(v);
  }
}

function types(d: Record<string, unknown>): Set<string> {
  const t = d["@type"];
  const arr = Array.isArray(t) ? t : [t];
  return new Set(arr.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()));
}

function offer(offers: unknown): [number, string | null, boolean | null] | null {
  let best: [number, string | null, boolean | null] | null = null;
  for (const o of walk(offers)) {
    const ty = types(o);
    if (!ty.has("offer") && !ty.has("aggregateoffer") && !("price" in o) && !("lowPrice" in o)) continue;
    let p = num(o.price) ?? num(o.lowPrice);
    let cur = typeof o.priceCurrency === "string" ? o.priceCurrency : null;
    if (p == null && o.priceSpecification) {
      for (const s of walk(o.priceSpecification)) {
        const sp = num(s.price);
        if (sp) { p = sp; cur = cur ?? (typeof s.priceCurrency === "string" ? s.priceCurrency : null); break; }
      }
    }
    if (p == null || p <= 0) continue;
    const avail = String(o.availability ?? "").toLowerCase();
    const stock = avail ? ["instock", "limitedavailability", "onlineonly", "presale"].some((k) => avail.includes(k)) : null;
    if (!best || p < best[0]) best = [p, cur, stock];
  }
  return best;
}

function img(v: unknown): string | null {
  if (Array.isArray(v)) v = v[0];
  if (v && typeof v === "object") v = (v as Record<string, unknown>).url ?? (v as Record<string, unknown>).contentUrl;
  return typeof v === "string" ? v : null;
}

export function parse(page: string): Product {
  const out: Product = { title: null, image: null, price: null, currency: null, in_stock: null };
  for (const m of page.matchAll(LD_RE)) {
    let data: unknown;
    try { data = JSON.parse(m[1].trim().replace(/[\u0000-\u001f]+/g, " ")); } catch { continue; }
    for (const d of walk(data)) {
      const ty = types(d);
      if (!ty.has("product") && !ty.has("productgroup")) continue;
      out.title ??= typeof d.name === "string" ? d.name : null;
      out.image ??= img(d.image);
      const off = offer(d.offers ?? d.hasVariant ?? []);
      if (off && out.price == null) [out.price, out.currency, out.in_stock] = off;
    }
  }
  const meta: Record<string, string> = {};
  for (const tag of page.match(META_RE) ?? []) {
    const a: Record<string, string> = {};
    for (const m of tag.matchAll(ATTR_RE)) a[m[1].toLowerCase()] = m[3] ?? m[4] ?? "";
    const key = (a.property || a.name || a.itemprop || "").toLowerCase();
    if (key && a.content && !(key in meta)) meta[key] = unescapeHtml(a.content);
  }
  out.title ??= meta["og:title"] ?? meta["twitter:title"] ?? null;
  out.image ??= meta["og:image"] ?? null;
  if (out.price == null) {
    for (const k of ["product:price:amount", "og:price:amount", "price"]) {
      const p = num(meta[k]);
      if (p && p > 0) {
        out.price = p;
        out.currency = meta["product:price:currency"] ?? meta["og:price:currency"] ?? meta["pricecurrency"] ?? null;
        break;
      }
    }
  }
  if (out.title == null) {
    const m = page.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    out.title = m ? unescapeHtml(m[1]) : null;
  }
  if (out.title) out.title = out.title.replace(/\s+/g, " ").trim().slice(0, 200);
  if (out.image && out.image.startsWith("//")) out.image = "https:" + out.image;
  if (out.image && !/^https?:\/\//.test(out.image)) out.image = null;
  if (out.currency && !/^[A-Z]{3}$/.test(out.currency)) out.currency = null;
  return out;
}
