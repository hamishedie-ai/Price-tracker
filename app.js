// Price Watch front end (GitHub Pages). Data lives in Supabase; row level security keeps each person's list private.
// All page text is set with textContent, never innerHTML, so shop titles cannot inject script.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://vsbpaiqdvxqyfydlkuso.supabase.co";
const SUPABASE_KEY = "sb_publishable_zcgFjDusNOXiDlUawMJ4aA_fFJ2sbs3"; // public key; safe in the page (RLS protects data)
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
// Stop other sites from showing this app inside a frame (clickjacking).
if (window.top !== window.self) { document.documentElement.hidden = true; throw new Error("framed"); }
const SITE = location.origin + location.pathname;

const $ = (id) => document.getElementById(id);
let me = null;        // { user_id, email, display_name, is_admin, must_change_password, alerts_on }

function show(which) {
  for (const s of ["login", "newpw", "app"]) $(s).hidden = s !== which;
}

const fmt = (p, cur) => p == null ? "—" : new Intl.NumberFormat("en-AU", { style: "currency",
  currency: /^[A-Z]{3}$/.test(cur || "") ? cur : "AUD", currencyDisplay: "narrowSymbol" }).format(Number(p));

function ago(ts) {
  if (!ts) return "checking soon";
  const s = (Date.now() - Date.parse(ts)) / 1000;
  if (s < 90) return "checked just now";
  if (s < 5400) return `checked ${Math.round(s / 60)} min ago`;
  if (s < 129600) return `checked ${Math.round(s / 3600)} h ago`;
  return `checked ${Math.round(s / 86400)} days ago`;
}

function friendly(err) {
  const m = (err && (err.message || err.error_description || String(err))) || "Something went wrong";
  if (/duplicate key/.test(m)) return "You are already watching this link";
  if (/up to 50/.test(m)) return "You can watch up to 50 links";
  if (/check constraint/.test(m)) return "That does not look like a full https:// link";
  if (/Invalid login/.test(m)) return "Wrong email or password";
  return m;
}

// ---------- items ----------
async function waitForCheck(id, since, el) {
  for (let i = 0; i < 30; i++) {           // up to about 3 minutes
    await new Promise((r) => setTimeout(r, 6000));
    const { data } = await sb.from("pw_items").select("*").eq("id", id).maybeSingle();
    if (!data) return;
    if (data.last_checked && data.last_checked !== since && !data.check_requested) {
      el.replaceWith(card(data)); summary(); return data;
    }
  }
}

function card(it) {
  const el = $("card-tpl").content.firstElementChild.cloneNode(true);
  const img = el.querySelector(".thumb");
  if (it.image && /^https:\/\//.test(it.image)) { img.src = it.image; img.onerror = () => { img.removeAttribute("src"); img.classList.add("none"); }; }
  else img.classList.add("none");
  const a = el.querySelector(".title");
  a.textContent = it.title || it.url;
  if (/^https?:\/\//i.test(it.url)) a.href = it.url;
  el.querySelector(".price").textContent = fmt(it.price, it.currency);
  const b = el.querySelector(".badge");
  const change = it.price != null && it.first_price != null ? Number(it.price) - Number(it.first_price) : 0;
  if (it.target != null && it.price != null && Number(it.price) <= Number(it.target)) { b.textContent = "Below your alert price"; b.className = "badge target"; }
  else if (change < -0.004) { b.textContent = `▼ ${fmt(-change, it.currency)}`; b.className = "badge down"; }
  else if (change > 0.004) { b.textContent = `▲ ${fmt(change, it.currency)}`; b.className = "badge up"; }
  else b.remove();
  const bits = [];
  if (it.lowest != null) bits.push(`lowest ${fmt(it.lowest, it.currency)}`);
  if (it.target != null) bits.push(`alert below ${fmt(it.target, it.currency)}`);
  if (it.in_stock === false) bits.push("out of stock");
  bits.push(it.check_requested ? "checking now…" : ago(it.last_checked));
  el.querySelector(".meta").textContent = bits.join(" · ");
  el.querySelector(".err").textContent = it.last_error || "";

  const bc = el.querySelector(".act-check");
  bc.onclick = async () => {
    bc.disabled = true; bc.textContent = "Checking…";
    const { error } = await sb.from("pw_items").update({ check_requested: true }).eq("id", it.id);
    if (error) { bc.textContent = "Failed"; return; }
    const done = await waitForCheck(it.id, it.last_checked, el);
    if (!done) { bc.disabled = false; bc.textContent = "Still waiting — try later"; }
  };
  el.querySelector(".act-target").onclick = async () => {
    const v = prompt("Email me when the price is at or below ($). Leave empty for any drop.",
                     it.target != null ? String(it.target) : "");
    if (v === null) return;
    const t = v.trim() === "" ? null : Number(v.replace(/[$,\s]/g, ""));
    if (t !== null && !(t > 0 && t < 1000000)) { alert("Type a number, for example 199"); return; }
    const { data, error } = await sb.from("pw_items").update({ target: t }).eq("id", it.id).select().single();
    if (error) alert(friendly(error)); else el.replaceWith(card(data));
  };
  el.querySelector(".act-del").onclick = async () => {
    if (!confirm(`Stop watching "${it.title || it.url}"?`)) return;
    const { error } = await sb.from("pw_items").delete().eq("id", it.id);
    if (error) alert(friendly(error)); else { el.remove(); summary(); }
  };
  return el;
}

function summary() {
  const n = $("list").children.length;
  $("summary").textContent = n ? `${n} watched` : "";
  $("empty").hidden = n > 0;
}

async function loadItems() {
  const { data, error } = await sb.from("pw_items").select("*").order("created_at", { ascending: false });
  if (error) { $("add-msg").textContent = friendly(error); return; }
  $("list").replaceChildren(...data.map(card));
  summary();
  for (const it of data) if (it.check_requested || !it.last_checked) {
    const el = [...$("list").children][data.indexOf(it)];
    waitForCheck(it.id, it.last_checked, el);
  }
}

$("add-form").onsubmit = async (e) => {
  e.preventDefault();
  const btn = $("add-btn"), msg = $("add-msg");
  const t = $("target").value.trim();
  let url = $("url").value.trim();
  try { url = new URL(url).toString(); } catch { msg.textContent = "Paste a full link that starts with https://"; msg.className = "msg bad"; return; }
  btn.disabled = true; msg.className = "msg"; msg.textContent = "Adding…";
  const { data, error } = await sb.from("pw_items").insert({ url, target: t ? Number(t) : null }).select().single();
  btn.disabled = false;
  if (error) { msg.textContent = friendly(error); msg.className = "msg bad"; return; }
  $("url").value = ""; $("target").value = "";
  const el = card(data);
  $("list").prepend(el); summary();
  msg.textContent = "Added. Reading the price… this takes about a minute.";
  const done = await waitForCheck(data.id, null, el);
  msg.textContent = !done ? "Added. The price will show after the next check." :
    done.price != null ? `Watching. Price now ${fmt(done.price, done.currency)}.` :
    "Added, but no price was found on that page. It will keep trying.";
};

// ---------- settings ----------
$("alerts-on").onchange = async (e) => {
  const { error } = await sb.from("pw_members").update({ alerts_on: e.target.checked }).eq("user_id", me.user_id);
  if (error) { alert(friendly(error)); e.target.checked = !e.target.checked; }
};
$("chpw-form").onsubmit = async (e) => {
  e.preventDefault();
  const { error } = await sb.auth.updateUser({ password: $("chpw1").value });
  $("chpw-msg").textContent = error ? friendly(error) : "Password changed.";
  if (!error) $("chpw1").value = "";
};
$("logout").onclick = async () => { await sb.auth.signOut(); location.reload(); };

for (const b of document.querySelectorAll(".tabs button")) {
  b.onclick = () => {
    for (const x of document.querySelectorAll(".tabs button")) x.setAttribute("aria-pressed", String(x === b));
    for (const t of ["list", "settings", "people"]) $("tab-" + t).hidden = b.dataset.tab !== t;
    if (b.dataset.tab === "people") loadMembers();
  };
}

// ---------- people (owner only) ----------
async function admin(body) {
  const { data, error } = await sb.functions.invoke("pw-admin", { body });
  if (error) {
    let m = error.message;
    try { m = (await error.context.json()).error || m; } catch { /* keep message */ }
    throw new Error(m);
  }
  return data;
}

async function loadMembers() {
  const box = $("members");
  box.textContent = "Loading…";
  try {
    const list = await admin({ action: "list" });
    box.replaceChildren(...list.map((m) => {
      const row = document.createElement("div"); row.className = "member";
      const who = document.createElement("div"); who.className = "who";
      who.textContent = m.display_name || m.email;
      const small = document.createElement("small");
      small.textContent = m.email + (m.is_admin ? " · owner" : m.must_change_password ? " · not logged in yet" : "");
      who.append(small); row.append(who);
      if (!m.is_admin) {
        const rm = document.createElement("button"); rm.className = "btn small danger"; rm.textContent = "Remove";
        rm.onclick = async () => {
          if (!confirm(`Remove ${m.email}? Their list is deleted too.`)) return;
          try { await admin({ action: "remove", user_id: m.user_id }); loadMembers(); } catch (e) { alert(e.message); }
        };
        row.append(rm);
      }
      return row;
    }));
  } catch (e) { box.textContent = e.message; }
}

$("invite-form").onsubmit = async (e) => {
  e.preventDefault();
  const msg = $("inv-msg"); msg.className = "msg"; msg.textContent = "Making account…";
  $("inv-btn").disabled = true;
  try {
    const name = $("inv-name").value.trim();
    const r = await admin({ action: "invite", email: $("inv-email").value.trim(), name });
    $("inv-out").textContent =
      `Hi${name ? " " + name : ""}! I set you up on Price Watch. Paste in links to things you want, and it emails you when the price drops.\n\n` +
      `${SITE}\nEmail: ${r.email}\nOne-time password: ${r.temp_password}\n\nOn iPhone: open the link in Safari, tap Share, then "Add to Home Screen".`;
    $("inv-out-wrap").hidden = false;
    msg.textContent = "Account made."; $("inv-email").value = ""; $("inv-name").value = "";
    loadMembers();
  } catch (err) { msg.textContent = err.message; msg.className = "msg bad"; }
  finally { $("inv-btn").disabled = false; }
};
$("inv-copy").onclick = async () => {
  try { await navigator.clipboard.writeText($("inv-out").textContent); $("inv-copy").textContent = "Copied"; }
  catch { alert("Press and hold the message to copy it"); }
};

// ---------- start ----------
async function enter() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { show("login"); return; }
  const { data, error } = await sb.from("pw_members").select("*").maybeSingle();
  if (error || !data) {
    await sb.auth.signOut();
    show("login"); $("login-msg").textContent = "This account is not invited to Price Watch."; $("login-msg").className = "msg bad";
    return;
  }
  me = data;
  if (me.must_change_password) { show("newpw"); return; }
  $("my-email").textContent = me.email;
  $("alerts-on").checked = me.alerts_on;
  $("people-btn").hidden = !me.is_admin;
  show("app");
  loadItems();
}

$("login-form").onsubmit = async (e) => {
  e.preventDefault();
  $("login-msg").textContent = ""; $("login-msg").className = "msg";
  const { error } = await sb.auth.signInWithPassword({ email: $("email").value.trim(), password: $("pw").value });
  if (error) { $("login-msg").textContent = friendly(error); $("login-msg").className = "msg bad"; return; }
  $("pw").value = "";
  enter();
};

$("newpw-form").onsubmit = async (e) => {
  e.preventDefault();
  const a = $("newpw1").value, b = $("newpw2").value, msg = $("newpw-msg");
  if (a !== b) { msg.textContent = "The two passwords are not the same"; msg.className = "msg bad"; return; }
  const { error } = await sb.auth.updateUser({ password: a });
  if (error) { msg.textContent = friendly(error); msg.className = "msg bad"; return; }
  await sb.from("pw_members").update({ must_change_password: false }).eq("user_id", me.user_id);
  enter();
};

enter();
setInterval(() => { if (!$("app").hidden && !$("tab-list").hidden && document.visibilityState === "visible") loadItems(); }, 300000);
