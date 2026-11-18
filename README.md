# Price Watch

Paste a product link, see its current price, and get an email when the price drops. Invite-only, for friends and family.

**App:** https://hamishedie-ai.github.io/Price-tracker/
On iPhone: open the link in Safari → Share → **Add to Home Screen**.

## How it works

| Part | Where | Job |
| --- | --- | --- |
| Web app (`index.html`, `app.js`, `style.css`) | GitHub Pages | Log in, add links, see prices. Talks only to Supabase. |
| Database + logins | Supabase (`pw_*` tables) | Each person's list is private (row level security). The browser can only add a link, set an alert price, ask for a re-check and delete. |
| Price checker (`worker/`) | Owner's home server, Docker | Opens each shop page in a real browser, reads the price, reports it through secret-gated database functions. Outgoing connections only. |
| `pw-cron` Edge Function | Supabase, every 30 min | Sends price-drop emails. If the home server is offline for 2+ hours, does basic checks itself. |
| `pw-admin` Edge Function | Supabase | Owner only: invite or remove people. |

Prices are checked about every 6 hours, and straight away when a link is added or "Check now" is tapped.

## Security notes

- Invite-only: accounts are made by the owner; a new person must choose their own password at first login.
- Row level security on every table; prices and titles are written only by the server.
- The page sets text with `textContent` only (no HTML from shops is ever inserted) and has a strict Content Security Policy.
- Secrets (worker secret, Gmail app password) live only in the home server's `.env` and Supabase secrets — never in this repo.
- The checker refuses links that point to private/home-network addresses.
