# Pro launch runbook

Pro is built and tested but off. Launch is three settings and one line.

## 1. Stripe (once, the account owner)

1. Create the account at stripe.com and finish activation (identity, address, bank account for payouts). Stripe can take a day to verify, so do this first.
2. Product catalog → Add product: **Two-Minute Drill Pro**, one-time price **$4.99**. Note the price id (`price_…`).
3. Developers → API keys → **Create restricted key**: name it `two-minute-drill-board`, give it **Checkout Sessions: Write** only. Copy it (`rk_live_…`). A restricted key is all the worker needs; never use the full secret key, and never put any key in chat, email or code.
4. Developers → Webhooks → Add endpoint: `https://<the worker's address>/stripe-webhook` (Cloudflare → Workers & Pages → `two-minute-drill-board` shows the `workers.dev` address). Events: `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Copy the signing secret (`whsec_…`).
5. Settings → Payment methods: leave the defaults. Cards, Apple Pay, Google Pay and Link are on for Checkout; nothing to register for Apple Pay on a Stripe-hosted page.

## 2. Cloudflare (the same person)

Workers & Pages → `two-minute-drill-board` → Settings → Variables and Secrets:

| name | type | value |
| --- | --- | --- |
| `STRIPE_SECRET` | secret | the restricted key from step 3 |
| `STRIPE_WEBHOOK_SECRET` | secret | the signing secret from step 4 |

Secrets survive deploys; plain variables set in the dashboard do not, which is why the price id goes in the repo instead.

## 3. The repo

1. `nfl-time-management/board/wrangler.toml`: set `STRIPE_PRICE = "price_…"` and merge (the board workflow deploys the worker).
2. `.github/workflows/site.yml`: set `PRO_ON: "on"` and merge. The site workflow then builds the historic drives and the playoff runs and ships the site with `--pro`, which turns the Pro tab on. About 40 minutes.

## 4. Check it (the first buyer should be you)

- Open the site, Pro tab, **Unlock · $4.99**: Stripe's page opens with Apple Pay on an iPhone in Safari. Pay. You land back on the site with "Pro unlocked" and a code `TMD-XXXX-XXXX-XXXX` on the Pro tab.
- On another device, Pro tab, enter the code under Restore: Pro turns on there.
- Stripe → Payments shows the charge; Developers → Webhooks shows the event delivered (200).
- Refund yourself from the Stripe dashboard if you like; the code keeps working (refunds are not revoked automatically; see below).

To try it before going live, do steps 1.2–1.4 and 2 in Stripe's **test mode** (toggle top right; the keys read `rk_test_…`, `whsec_…`) and pay with card `4242 4242 4242 4242`, any future date, any CVC. Switch the three values to live ones when done.

## How it works

- `/pay` creates a Checkout session (API version pinned, session tagged `tmd_pro_…`), with the success address `/?claim=<session>`. Payment methods come from the Stripe Dashboard, not the call.
- `/claim` checks the session is paid and gives the code (the same code again for the same session). The webhook mints the code the moment Stripe marks the session paid, so a buyer who closed the tab, or paid by a slower bank method, still has a code waiting the first time the page asks.
- `/restore` turns a code into Pro on another device. Codes have about 60 bits of entropy and guesses are rate limited per IP.
- Stored on the worker: the code and the session id behind it. No names, emails or card details; Stripe holds the receipt. The privacy page says so.

## Not automated (by choice)

- A refund does not revoke the code. Rare enough at $4.99 that a manual step is fine: Stripe → the payment → the session id → ask for the code to be removed.
- Chargebacks: same.
- Codes are stored per worker (one Durable Object); back them up by exporting if that ever matters.
