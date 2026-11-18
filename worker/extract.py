"""Find a product's name, image, price and stock state in a web page (JSON-LD first, then meta tags)."""
import html as htmlmod
import json
import re

LD_RE = re.compile(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', re.S | re.I)
META_RE = re.compile(r'<meta\s+[^>]*>', re.I)
ATTR_RE = re.compile(r'([\w:-]+)\s*=\s*("([^"]*)"|\'([^\']*)\')')


def _num(v):
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    m = re.search(r'\d[\d,]*(?:\.\d+)?', str(v))
    try:
        return float(m.group(0).replace(",", "")) if m else None
    except ValueError:
        return None


def _walk(o):
    if isinstance(o, list):
        for x in o:
            yield from _walk(x)
    elif isinstance(o, dict):
        yield o
        for v in o.values():
            if isinstance(v, (list, dict)):
                yield from _walk(v)


def _types(d):
    t = d.get("@type", [])
    return {x.lower() for x in (t if isinstance(t, list) else [t]) if isinstance(x, str)}


def _offer(offers):
    """Lowest positive price among the offers: (price, currency, in_stock or None)."""
    best = None
    for o in _walk(offers):
        if not (_types(o) & {"offer", "aggregateoffer"}) and "price" not in o and "lowPrice" not in o:
            continue
        p = _num(o.get("price")) or _num(o.get("lowPrice"))
        cur = o.get("priceCurrency")
        spec = o.get("priceSpecification")
        if p is None and spec:
            for s in _walk(spec):
                if _num(s.get("price")):
                    p, cur = _num(s.get("price")), cur or s.get("priceCurrency")
                    break
        if p is None or p <= 0:
            continue
        avail = str(o.get("availability", "")).lower()
        stock = None if not avail else any(k in avail for k in ("instock", "limitedavailability", "onlineonly", "presale"))
        if best is None or p < best[0]:
            best = (p, cur if isinstance(cur, str) else None, stock)
    return best


def _img(v):
    if isinstance(v, list):
        v = v[0] if v else None
    if isinstance(v, dict):
        v = v.get("url") or v.get("contentUrl")
    return v if isinstance(v, str) else None


def parse(page: str) -> dict:
    out = {"title": None, "image": None, "price": None, "currency": None, "in_stock": None}
    for block in LD_RE.findall(page):
        try:
            data = json.loads(htmlmod.unescape(block.strip()), strict=False)
        except Exception:
            continue
        for d in _walk(data):
            if not (_types(d) & {"product", "productgroup"}):
                continue
            out["title"] = out["title"] or d.get("name")
            out["image"] = out["image"] or _img(d.get("image"))
            off = _offer(d.get("offers") or d.get("hasVariant") or [])
            if off and out["price"] is None:
                out["price"], out["currency"], out["in_stock"] = off
    meta = {}
    for tag in META_RE.findall(page):
        a = {m.group(1).lower(): (m.group(3) if m.group(3) is not None else m.group(4)) for m in ATTR_RE.finditer(tag)}
        key = (a.get("property") or a.get("name") or a.get("itemprop") or "").lower()
        if key and a.get("content") and key not in meta:
            meta[key] = htmlmod.unescape(a["content"])
    out["title"] = out["title"] or meta.get("og:title") or meta.get("twitter:title")
    out["image"] = out["image"] or meta.get("og:image")
    if out["price"] is None:
        for k in ("product:price:amount", "og:price:amount", "price"):
            p = _num(meta.get(k))
            if p and p > 0:
                out["price"] = p
                out["currency"] = (meta.get("product:price:currency") or meta.get("og:price:currency")
                                   or meta.get("pricecurrency"))
                break
    if out["title"] is None:
        m = re.search(r"<title[^>]*>(.*?)</title>", page, re.S | re.I)
        out["title"] = htmlmod.unescape(m.group(1)).strip() if m else None
    if isinstance(out["title"], str):
        out["title"] = " ".join(out["title"].split())[:200]
    if isinstance(out["image"], str) and not out["image"].startswith(("http://", "https://", "//")):
        out["image"] = None
    return out
