"""Price Watch checker. Runs on the home server and reads shop pages with a real browser (sockpuppetbrowser),
then reports prices to Supabase through secret-gated functions. It only makes outgoing connections."""
import asyncio
import ipaddress
import json
import logging
import os
import re
import socket
import time
import urllib.parse
import urllib.request

from playwright.async_api import async_playwright

from extract import parse

SB_URL = os.environ["SB_URL"]
SB_KEY = os.environ["SB_KEY"]
SECRET = os.environ["PW_WORKER_SECRET"]
BROWSER_WS = os.environ.get("BROWSER_WS", "ws://browser:3000")
POLL = int(os.environ.get("POLL_SECONDS", "60"))
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("worker")


def rpc(fn: str, **args):
    req = urllib.request.Request(f"{SB_URL}/rest/v1/rpc/{fn}", data=json.dumps({"p_secret": SECRET, **args}).encode(),
                                 headers={"Content-Type": "application/json", "apikey": SB_KEY,
                                          "Authorization": f"Bearer {SB_KEY}"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        t = r.read().decode()
        return json.loads(t) if t.strip() else None


def public_host(host: str) -> bool:
    try:
        return all(ipaddress.ip_address(i[4][0]).is_global for i in socket.getaddrinfo(host, 443))
    except Exception:
        return False


AMAZON_SEL = ("#corePrice_feature_div .a-offscreen, #corePriceDisplay_desktop_feature_div .a-offscreen, "
              ".priceToPay .a-offscreen, #apex_desktop .a-price .a-offscreen, .a-price .a-offscreen")
GENERIC_SEL = "[itemprop=price]"


def money_text(s: str | None):
    if not s:
        return None
    m = re.search(r"\d[\d,]*(?:\.\d{1,2})?", s.replace("\xa0", " "))
    try:
        return float(m.group(0).replace(",", "")) if m else None
    except ValueError:
        return None


async def read(browser, url: str) -> dict:
    host = urllib.parse.urlsplit(url).hostname or ""
    if not await asyncio.to_thread(public_host, host):
        return {"error": "That link is not a public website"}
    ctx = await browser.new_context(locale="en-AU", timezone_id="Australia/Hobart", viewport={"width": 1366, "height": 900})
    try:
        page = await ctx.new_page()

        async def guard(route):  # never let a shop page reach the home network
            h = urllib.parse.urlsplit(route.request.url).hostname or ""
            if h and not await asyncio.to_thread(public_host, h):
                return await route.abort()
            await route.continue_()
        await page.route("**/*", guard)
        resp = await page.goto(url, wait_until="domcontentloaded", timeout=45000)
        try:
            await page.wait_for_load_state("networkidle", timeout=12000)
        except Exception:
            pass
        info = parse(await page.content())
        if info["price"] is None and "/products/" in urllib.parse.urlsplit(page.url).path:
            # Shopify shops (for example JB Hi-Fi): the product JSON has the price in cents.
            try:
                js = await page.evaluate("""async () => {
                    const r = await fetch(location.pathname.replace(/\\/$/, '') + '.js', {credentials: 'include'});
                    return r.ok ? await r.json() : null; }""")
                if js and js.get("price"):
                    info["price"] = round(js["price"] / 100, 2)
                    info["title"] = js.get("title") or info["title"]
                    img = js.get("featured_image") or ""
                    info["image"] = info["image"] or ("https:" + img if img.startswith("//") else img or None)
                    info["in_stock"] = bool(js.get("available"))
            except Exception as e:
                log.info("shopify json failed: %s", e)
        if info["price"] is None:
            sel = AMAZON_SEL if "amazon." in host else GENERIC_SEL
            loc = page.locator(sel).first
            if await loc.count():
                txt = await loc.get_attribute("content") or await loc.text_content()
                info["price"] = money_text(txt)
                if "amazon." in host:
                    info["currency"] = info["currency"] or "AUD"
                    t = await page.locator("#productTitle").first.text_content() if await page.locator("#productTitle").count() else None
                    info["title"] = (t or "").strip() or info["title"]
                    im = page.locator("#landingImage").first
                    if await im.count():
                        info["image"] = await im.get_attribute("src") or info["image"]
        err = None
        if urllib.parse.urlsplit(page.url).path in ("", "/") and urllib.parse.urlsplit(url).path not in ("", "/"):
            info["price"] = None
            err = "This product page no longer exists (the shop sent it to its home page)"
        if resp is not None and resp.status >= 400:
            err = f"The shop answered {resp.status}"
        if info["price"] is None:
            err = err or "No price found on this page"
        info["error"] = err
        return info
    finally:
        await ctx.close()


async def cycle():
    due = await asyncio.to_thread(rpc, "pw_worker_due", p_limit=10)
    if not due:
        return 0
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(BROWSER_WS, timeout=30000)
        try:
            for it in due:
                try:
                    info = await read(browser, it["url"])
                except Exception as e:
                    info = {"error": f"Could not read the page ({type(e).__name__})"}
                    log.warning("read %s failed: %s", it["url"], e)
                res = await asyncio.to_thread(
                    rpc, "pw_worker_report", p_id=it["id"], p_title=info.get("title"), p_image=info.get("image"),
                    p_currency=info.get("currency"), p_price=info.get("price"), p_in_stock=info.get("in_stock"),
                    p_error=info.get("error"))
                log.info("item %s: price=%s err=%s drop=%s", it["id"], info.get("price"), info.get("error"),
                         (res or {}).get("drop"))
                await asyncio.sleep(3)
        finally:
            await browser.close()
    return len(due)


async def main():
    log.info("Price Watch worker started")
    while True:
        try:
            await cycle()
            open("/tmp/healthy", "w").write(str(time.time()))
        except Exception as e:
            log.error("cycle failed: %s", e)
        await asyncio.sleep(POLL)


if __name__ == "__main__":
    asyncio.run(main())
