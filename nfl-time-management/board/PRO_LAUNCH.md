# Pro launch runbook

Pro is on (`PRO_ON: "on"` in `.github/workflows/site.yml`; `"off"` turns the tab off again). Payments need the two live secrets below; with a test key the worker refuses purchases from the site itself and the Pro tab says "Payments open soon".

## 1. Stripe (once, the account owner)

1. Finish activating the account at stripe.com (identity, address, bank account for payouts): the dashboard's **Activate payments** button. Stripe can take a day to verify, so do this first.
2. In **live mode** (not the sandbox): Developers → API keys → **Create restricted key**: name it `two-minute-drill-board`, give it **Checkout Sessions: Write** only. Copy it (`rk_live_…`). A restricted key is all the worker needs; never use the full secret key, and never put any key in chat, email or code.
3. Live mode: Developers → Webhooks (event destinations) → Add endpoint: `https://two-minute-drill-board.meashton87.workers.dev/stripe-webhook`. Events: `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Copy the signing secret (`whsec_…`).
4. The product: **Two-Minute Drill Pro** in the live catalog, with a **product category** (its tax code: Video Games, downloaded, `txcd_10201001`). Stripe's Managed Payments, on by default, refuses a Checkout line without a tax code. Its id goes in `STRIPE_PRICE` (wrangler.toml); the worker charges $4.99 against it. With `STRIPE_PRICE` empty the worker describes the product itself, with the same tax code.
5. Settings → Payment methods: leave the defaults. Cards, Apple Pay, Google Pay and Link are on for Checkout; nothing to register for Apple Pay on a Stripe-hosted page.

## 2. Cloudflare (the same person)

Workers & Pages → `two-minute-drill-board` → Settings → Variables and Secrets:

| name | type | value |
| --- | --- | --- |
| `STRIPE_SECRET` | secret | the live restricted key from step 2 (replacing the sandbox one) |
| `STRIPE_WEBHOOK_SECRET` | secret | the live signing secret from step 3 (replacing the sandbox one) |

Both go in as **Secret** (encrypted) values, never plain text: a secret never shows in a deploy's log or diff. (Plain variables set in the dashboard survive deploys too, `keep_vars` in wrangler.toml, but they are visible.)

## 3. The repo

1. `nfl-time-management/board/wrangler.toml`: set `STRIPE_PRICE = ""` (the sandbox product id no longer applies; a live id works too).
2. `.github/workflows/site.yml`: set `PRO_ON: "on"`. Merge both in one PR. The site workflow then builds the historic drives and the playoff runs, deploys the worker with them, and ships the site with `--pro`, which turns the Pro tab on. About 40 minutes.

## 4. Check it (the first buyer should be you)

- Open the site, Pro tab, **Unlock · $4.99**: Stripe's page opens with Apple Pay on an iPhone in Safari. Pay. You land back on the site with "Pro unlocked" and a code `TMD-XXXX-XXXX-XXXX` on the Pro tab.
- On another device, Pro tab, enter the code under Restore: Pro turns on there.
- Stripe → Payments shows the charge; Developers → Webhooks shows the event delivered (200).
- Refund yourself from the Stripe dashboard if you like; the code keeps working (refunds are not revoked automatically; see below).

The sandbox dry run is the same on the unlisted preview, https://nfl2mindrill-pro-preview.pages.dev (Pro on, the same worker with sandbox keys): pay with card `4242 4242 4242 4242`, any future date, any CVC. The two secrets switch to live values at launch.

## How it works

- `/pay` creates a Checkout session (API version pinned, session tagged `tmd_pro_…`), with the success address `/?claim=<session>`. Payment methods come from the Stripe Dashboard, not the call.
- `/claim` checks the session is paid and gives the code (the same code again for the same session). The webhook mints the code the moment Stripe marks the session paid, so a buyer who closed the tab, or paid by a slower bank method, still has a code waiting the first time the page asks.
- `/restore` turns a code into Pro on another device. Codes have about 60 bits of entropy and guesses are rate limited per IP.
- Stored on the worker: the code and the session id behind it. No names, emails or card details; Stripe holds the receipt. The privacy page says so.

## Not automated (by choice)

- A refund does not revoke the code. Rare enough at $4.99 that a manual step is fine: Stripe → the payment → the session id → ask for the code to be removed.
- Chargebacks: same.
- Codes are stored per worker (one Durable Object); back them up by exporting if that ever matters.
