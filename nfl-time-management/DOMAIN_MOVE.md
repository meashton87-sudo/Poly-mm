# Moving Two-Minute Drill to 2mindrills.com

Old address: **nfl2mindrill.com** (and www.nfl2mindrill.com). New address: **2mindrills.com** (and www.2mindrills.com).

The code is ready. Changing the address is two GitHub variables (step 6). Everything else on this page happens in
other companies' dashboards. Nothing changes for players until step 6, and every step before it can be done days ahead.

How the move works for players: for the first few weeks the old address keeps serving the site. Every page there sends
the visitor to the same page on 2mindrills.com, and brings along everything the game saved in their browser: streak,
stats, Pro code, sign-in, name, settings, today's drive. Nothing already saved on 2mindrills.com is overwritten. A
browser keeps saved data separately for each address, so this hand-over is the only way that data can move, and it only
works while the old address still serves the site. That is why the Cloudflare redirect rule (step 13) comes last.

**Must do before the switch:** steps 1 to 5 (the domain in Cloudflare, the domain on the Pages project, www to the bare
address, Google sign-in origins, Ezoic and AdSense for the new site). **Switch day:** steps 6 to 9. **Later:** 10 to 15.
Do **not** add the redirect rule (step 13) on switch day.

Each step is marked:
- **BEFORE**: do it before the switch. The switch breaks something without it.
- **SWITCH**: switch day, in this order.
- **AFTER**: any time after the switch. Nothing breaks while it waits.

---

## Before the switch

### 1. BEFORE: Get 2mindrills.com into Cloudflare
- Bought through Cloudflare: dash.cloudflare.com → **Domain Registration → Register Domains**, search `2mindrills.com`,
  buy it. It becomes a site in your account automatically.
- Bought somewhere else: dash.cloudflare.com → **Add a domain** → `2mindrills.com` → Free plan → copy the two
  nameservers Cloudflare shows → paste them in at the other registrar → wait until Cloudflare says the domain is
  **Active** (usually under an hour).
- Turn on auto-renew. Leave **nfl2mindrill.com** exactly as it is, and keep it registered and on auto-renew for at
  least two years.

### 2. BEFORE: Add 2mindrills.com to the Pages project (keep the old address on it too)
dash.cloudflare.com → **Workers & Pages** → **nfl2mindrill** (the Pages project) → **Custom domains** → **Set up a
custom domain** → `2mindrills.com` → **Continue** → **Activate domain**. Do it again for `www.2mindrills.com`.
Wait until both say **Active** (SSL certificate included, a few minutes).

- Do **not** remove `nfl2mindrill.com` or `www.nfl2mindrill.com` from this list. The old address must keep serving the
  same build: that is what hands players over.
- After this step, 2mindrills.com already shows the game. Until step 6 it still calls itself nfl2mindrill.com, and
  leaderboards, Pro and sign-in do not work on it yet. That is expected. Don't share the new address before step 6.

### 3. BEFORE: Send www.2mindrills.com to 2mindrills.com
dash.cloudflare.com → **2mindrills.com** → **Rules** → **Redirect Rules** → **Create rule** → pick the template
**Redirect from WWW to root**. Or fill it in by hand:
- Rule name: `www to root`
- When incoming requests match: **Custom filter expression** → `(http.host eq "www.2mindrills.com")`
- Then: **URL redirect**, Type **Dynamic**, Expression `concat("https://2mindrills.com", http.request.uri.path)`,
  Status code **301**, **Preserve query string** ticked
- **Deploy**

Why: a browser treats `www.` as a separate address with its own saved data. If every visitor lands on the bare
address, every player keeps one record.

### 4. BEFORE: Google sign-in: allow the new address
console.cloud.google.com → pick the project that owns the client `1079340119845-i8p0d0c57dmoa1hluqkm15ofi33oe9ms` →
**Google Auth Platform → Clients** (older menus: **APIs & Services → Credentials → OAuth 2.0 Client IDs**) → click the web
client → **Authorized JavaScript origins** → **Add URI** → `https://2mindrills.com` → **Add URI** →
`https://www.2mindrills.com` → **Save**. Keep the nfl2mindrill.com origins.
- Then **Google Auth Platform → Branding** (older menus: **OAuth consent screen**): under **Authorized domains** add
  `2mindrills.com`. Set the home page to `https://2mindrills.com/` and the privacy policy to
  `https://2mindrills.com/privacy`. **Save**. If Google asks you to prove you own the domain, add the Search
  Console property first (step 14, first bullet).
- Google can take anywhere from 5 minutes to a few hours to apply this. Do it at least a day before the switch.
  Without it, "Sign in with Google" fails on 2mindrills.com. The client id itself stays the same, so nothing changes
  in the code.

### 5. BEFORE: Ads: Ezoic and AdSense know the new site
On switch day the site's `/ads.txt` starts redirecting to
**`https://srv.adstxtmanager.com/19390/2mindrills.com`** on its own (the build follows SITE_DOMAIN). That address
has to exist first:
- **Ezoic**: email Kyle (your Ezoic contact). Tell him the site is moving from nfl2mindrill.com to 2mindrills.com, give
  him the switch date, and ask him to (1) add 2mindrills.com to your Ezoic account and its ads.txt manager (publisher
  19390), (2) carry over the site's setup and approval, and (3) put the AdSense line
  `google.com, pub-7590842699855700, DIRECT, f08c47fec0942fa0` in the new domain's ads.txt. Before you switch, open
  `https://srv.adstxtmanager.com/19390/2mindrills.com` in a browser. It must list ad lines, not show an error.
- **AdSense**: adsense.google.com → **Sites** → **Add site** → `2mindrills.com` → **Save** → **Request review**. Step 2
  already serves the game there, with the AdSense code on it, so the review can start now. Reviews can take from a few
  days to a couple of weeks. Until 2mindrills.com shows **Ready**, AdSense shows no ads on it. Start this as early as
  you can.

---

## Switch day

### 6. SWITCH: Set the two GitHub variables, then deploy
github.com/meashton87-sudo/Poly-mm → **Settings** → **Secrets and variables** → **Actions** → **Variables** tab:
- `SITE_DOMAIN`: click it → **Edit** (or **New repository variable** if it isn't there) → value `2mindrills.com` → **Update**
- **New repository variable** → name `OLD_DOMAIN` → value `nfl2mindrill.com` → **Add variable**

Then **Actions** → **Two-Minute Drill website** → **Run workflow** → branch `main` → **Run workflow**. It takes an
hour or more. When it is green, check two steps in the run log:
- **Deploy the worker with the Pro data** ran (it was not skipped). That step points the worker at the new address:
  its links, Stripe's return page, and which pages may call it.
- **The worker answers the new address** passed. If the worker is not ready, this step stops the run and the site is
  not published, so players see no change. Fix it by running **Actions → Two-Minute Drill leaderboard → Run workflow**,
  then run the website workflow again.

The same build now goes out on both addresses. On nfl2mindrill.com every page passes the visitor, with their saved data,
to the same page on 2mindrills.com.

Only if you also publish to GitHub Pages (the variable `PAGES_DEPLOY` is `true`): **Settings → Pages → Custom domain** →
`2mindrills.com` → **Save**. The `CNAME` file at the top of the repository is not used by the workflow, so leave it.

### 7. SWITCH: Check it on your own phone
On the phone where you play, open **nfl2mindrill.com** the way you usually do (bookmark or home-screen icon):
- You end up on **2mindrills.com** with your streak in the top bar, and a one-time note that the game moved. If you
  opened it from the home-screen icon, the note explains how to add the new icon.
- The address bar shows no long `#tmd-move=…` text.
- The Pro tab opens. If you were signed in, you still are.
- `https://2mindrills.com/ads.txt` shows Ezoic's lines. `https://2mindrills.com/sitemap.xml` lists 2mindrills.com
  addresses.
- Sign in with Google works on 2mindrills.com (step 4).

To undo, the same day: delete `OLD_DOMAIN`, set `SITE_DOMAIN` back to `nfl2mindrill.com`, and run the website workflow
again. Data saved on 2mindrills.com stays there. Signed-in players get it back on the old address through their account.
Don't switch back and forth.

### 8. SWITCH: Stripe
dashboard.stripe.com (live mode) → **Settings** → **Business** → **Public details** → **Website** →
`https://2mindrills.com` → **Save**. Update the support website there too if it names the old address.
- Nothing else in Stripe changes. The worker builds Checkout's success and cancel addresses from the page the buyer
  came from (now 2mindrills.com). The webhook goes to the worker's own address, which does not change.
- Apple Pay and Google Pay: Pro is paid on Stripe's own hosted Checkout page (checkout.stripe.com), so Apple Pay is
  verified on Stripe's domain and needs no domain registration from you. Only if Stripe's payment form is ever put
  inside our own pages: **Settings → Payments → Payment method domains → Add a new domain → `2mindrills.com`**. It does
  no harm to add it now.

### 9. SWITCH (or AFTER): Emails come from the new address (Resend)
Sign-in, lost-code and daily-reminder emails already link to 2mindrills.com from step 6. This step changes the sender.
- resend.com → **Domains** → **Add Domain** → `2mindrills.com` → **Add**. Resend lists the DNS records it needs (MX
  and TXT on `send`, TXT `resend._domainkey`). Pick **Auto configure** (Cloudflare sign-in), or add each one under
  Cloudflare → **2mindrills.com** → **DNS** → **Records** → **Add record** (TXT and MX records are never proxied). Then
  **Verify DNS records** and wait for **Verified**.
- Then dash.cloudflare.com → **Workers & Pages** → **two-minute-drill-board** → **Settings** → **Variables and
  Secrets** → `MAIL_FROM` → **Edit**. Keep the name and the part before the @, change only the domain, for example
  `Two-Minute Drill <signin@2mindrills.com>` → **Deploy**.
- If your Resend plan only allows one domain: do this between 11:00 UTC and 07:00 UTC (the daily emails go out from
  08:05 to 10:05 UTC). Delete nfl2mindrill.com in Resend, add and verify 2mindrills.com, and change `MAIL_FROM` straight
  away. Sign-in emails fail for those few minutes.

---

## After the switch

### 10. AFTER: Google Analytics
analytics.google.com → **Admin** → **Data streams** → the web stream → pencil next to the stream URL →
`https://2mindrills.com` → **Save**. Then, on the same stream page: **Configure tag settings** → **Show more** → **List
unwanted referrals** → add a condition **Referral domain contains** `nfl2mindrill.com` → **Save**. Without that, every
handed-over visit counts as a referral from the old address. The measurement id (G-4QQ8N62SMB) stays the same, so
nothing changes in the code.

### 11. AFTER: X
x.com → your profile → **Edit profile** → **Website** → `2mindrills.com`. Change the bio and the pinned post if they
mention nfl2mindrill.com → **Save**. The handle @TwoMinuteDrill0 can stay as it is.

### 12. AFTER: Tell the regulars (optional)
A post like "Two-Minute Drill now lives at 2mindrills.com. Your streak comes with you: just open the old link once."
Old links keep working the whole time.

### 13. AFTER, at least 4 weeks after the switch: The old address answers with a 301
Wait at least four weeks, so that every regular has opened the game once and been handed over. Then:

dash.cloudflare.com → **nfl2mindrill.com** → **Rules** → **Redirect Rules** → **Create rule**:
- Rule name: `Moved to 2mindrills.com`
- When incoming requests match: **Custom filter expression** → **Edit expression** →
  ```
  (http.host in {"nfl2mindrill.com" "www.nfl2mindrill.com"} and not (http.request.uri.path in {"/move" "/move.html"}))
  ```
- Then: **URL redirect** → Type **Dynamic** → Expression
  ```
  concat("https://2mindrills.com", http.request.uri.path)
  ```
  → Status code **301** → **Preserve query string** ticked
- **Deploy**

Every old link now goes straight to the same page and query on 2mindrills.com. Browsers keep the `#…` part on their own.
The rule leaves out `/move`. While `OLD_DOMAIN` is set, the new site's home page shows anyone with nothing saved a
link: "Played on nfl2mindrill.com before? Bring your streak and stats over". That link goes to
nfl2mindrill.com/move, which still hands their data over. So nobody who comes back late loses anything.

### 14. AFTER: Google Search Console (the change of address only after step 13)
- search.google.com/search-console → **Add property** → **Domain** → `2mindrills.com` → verify it (pick Cloudflare when
  offered, or add the TXT record under **DNS → Records**) → **Sitemaps** → `https://2mindrills.com/sitemap.xml` →
  **Submit**. Adding the property can happen any time after step 6.
- After step 13: open the **nfl2mindrill.com** property → **Settings** → **Change of address** → choose
  `2mindrills.com` → **Validate & update**. The tool insists that the old home page answers with a 301, so it only works
  after step 13. Keep both properties.

### 15. What keeps running on the old address, and for how long
- **The nfl2mindrill.com registration**: on auto-renew for at least 2 years. The 301 keeps old links, bookmarks, emails,
  calendar reminders and home-screen icons working.
- **nfl2mindrill.com on the Pages project** (step 2) and **`OLD_DOMAIN` = `nfl2mindrill.com`** (step 6): keep both as
  long as you keep the domain. Remove `OLD_DOMAIN` only if you also take nfl2mindrill.com off the Pages project and
  replace step 13's rule with one that has no `/move` exception. Otherwise `/move` would show the game on the old
  address again.
- **Google sign-in origins** and the **AdSense site** for the old address: harmless, leave them.
- **Resend**: once `MAIL_FROM` uses 2mindrills.com, you can delete nfl2mindrill.com in Resend after a week.
- **Ezoic and AdSense**: the old site can go once Kyle confirms 2mindrills.com earns and the old address only redirects.

---

## What the code already does (nothing to do)
- The address is one setting. `SITE_DOMAIN` drives the pages' canonical links, sitemap, robots.txt, link previews
  (og.png names the address: `web/og.2mindrills.com.png` is used for 2mindrills.com), share text, calendar reminder
  files, the CNAME file, the Ezoic ads.txt redirect (site.yml `EZOIC_ADSTXT: "site"`), and the worker's `SITE` and
  `ALLOWED_ORIGINS` (`board/site_vars.mjs`). The old name is written only as the default for when no address is set
  (`scripts/site.py` `DEFAULT_DOMAIN`; the worker's fallback and wrangler.toml's starting values, which
  `site_vars.mjs` replaces at deploy), and in page text that the build replaces. The Cloudflare project names (`nfl2mindrill`,
  `nfl2mindrill-pro-preview`) only show in their `pages.dev` addresses and stay as they are.
- The hand-over (`web/move.js`):
  - Saved data travels in the part of the link after `#`, which browsers never send to any server.
  - Only a real hand-over from nfl2mindrill.com is imported, never a link someone made up.
  - Data is only added where nothing is saved yet. Days, drives and scenarios are merged.
  - The device key comes along with the Pro code, so the board sees the same device and no extra Pro slot is used.
  - The `#…` text is removed from the address before anything else runs.
- `scripts/move_test.py` runs all of this in Chromium with both real addresses, as CI does before every deploy.
