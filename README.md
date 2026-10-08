# poly-mm

A Polymarket parlay market maker built around one idea: **take fair value from the
sportsbooks, quote around it, and above all don't get run over.**

```
python -m polymm          # worked example: Bucs ML + Irving o24.5
python -m polymm.sim      # Monte Carlo: naive vs protected market maker
python -m polymm.scan --offline   # value scanner demo (see below)
python -m pytest          # 43 tests
```

There are no runtime dependencies (stdlib only). `pip install -e .[live]` adds
`py-clob-client` for the live Polymarket adapter.

## The example

```
Leg fair values (de-vigged, weighted, outlier-checked):
  bucs_ml      p=0.3035 (+230)  sigma=0.0092  books=6
  irving_over  p=0.3524 (+184)  sigma=0.0098  books=6

Parlay fair: 0.1070 = +835  (sigma 0.0044)
Book parlay offers: draftkings +700, hardrock +799, fanduel +740

  fair 0.1070 (+835) | bid 0.100 x 250 | ask 0.120 x 250 (bettor gets +733)
  (on a 0.001-tick market: bid 0.099 | ask 0.115 (bettor gets +770))

-- Injury news hits on Bucs QB --
  PULLED: Bucs QB questionable (news feed)
```

Note that **fair is not a weighted average of +700 and +799.** Book parlay prices
carry a large hold: DraftKings' +700 implies 12.5%, but the de-vigged legs say
10.7%, so the hold is about 17%. Averaging parlay prices gives you a vigged "fair"
value, and every share you sell at it loses money. Fair value comes from the
**de-vigged legs**. The book parlay prices are used as **boundaries** instead:

- **Ask**: beat the best book by a little and no more. We don't give away more edge
  than it takes to be the best price available.
- **Bid**: always strictly below the best book's parlay price. Otherwise someone can
  bet the parlay at Hard Rock and sell it to us for a guaranteed profit.
- **If our fair is at or above a book's parlay price**, our inputs are stale or that
  book is wrong. We pull the quote.

## How each worry is handled

| Concern | Where | What it does |
|---|---|---|
| **Fair value point estimate** | `odds.py`, `fair_value.py` | Shin / power / multiplicative de-vig. Averages books in logit space, weighted by sharpness (Pinnacle/Circa > rec books) × recency decay. Rejects outliers using MAD. Uncertainty = cross-book dispersion / √n_eff plus a model-risk floor. |
| **Correlated legs** | `parlay.py` | Gaussian copula: an exact bivariate CDF for 2 legs and Monte Carlo for n legs. Uncertainty in the correlation estimate is added to σ. Same-game parlays priced as independent are the classic way to get picked off. |
| **Spread optimization** | `quoting.py` | half-spread = base + k·σ(fair) + toxicity widening. Inventory skew moves the reservation price. Sizes shrink on the side that adds inventory. Prices are rounded to the tick with a hard minimum-edge floor. |
| **Risk / correlated exposure** | `risk.py` | Risk is measured over **legs, not markets**: short Bucs+Irving and short Bucs+Lakers is a double short on Bucs. It enumerates every leg-outcome scenario and enforces: worst-case loss per market and for the whole portfolio (solved exactly, since P&L is linear in size), **per-leg exposure** E[PnL\|miss]−E[PnL\|hit], CVaR₉₅ under fair probabilities and correlations, position/order caps, and a daily-loss kill switch. Every order is sized to the largest size that breaches no limit. |
| **Adverse selection / toxic flow** | `toxicity.py` | Markouts: where fair value went N seconds after each fill. An EWMA of adverse drift gives a toxicity score that widens spreads and shrinks size. **Burst detection** (3 fills on one side within 5s) pulls that side. Per-counterparty markout stats show who is picking you off. |
| **Speed** | `guards.py`, `engine.py` | **Cancel first, think later.** Quotes are pulled on any of: stale feed, a fair-value jump, the sharp book diverging from the pack (news is spreading), books disagreeing, game start, the kill switch, or a manual/news-feed `on_news()` hook. Feed updates arrive in batches, so there is one requote per poll. Orders aren't replaced for small size changes, which keeps you under rate limits. |

## Simulation (`python -m polymm.sim --trials 60`)

The simulated world has a drifting true probability, one injury-size news shock,
6 books with realistic lags (Pinnacle 2s … BetMGM 30s), noise traders, and
informed bots that see the truth instantly and sweep any quote that's wrong.
P&L is measured as expected value at the final true probability.

```
     naive: mean EV P&L   +39.52  median   +26.60  5th pct   -83.66  volume 8552 sh
 protected: mean EV P&L   +43.59  median   +43.99  5th pct   +22.45  volume 5261 sh
```

The naive maker (equal weights, tight spread, no guards) trades more volume and has
a similar mean. Its left tail is much worse, though: the news shock is where it gets
run over. The protected maker gives up some volume and almost removes the tail.
**This is a toy world. Calibrate it against your own fills before you believe any
number in it.**

## Value scanner (`polymm.scan`)

### The easy way: the dashboard

**Windows:** double-click **`Start Scanner.bat`**. A browser tab opens with the
dashboard. Leave the black window open while you use it; close it to stop.
(`Start Scanner (demo).bat` opens the same page on built-in sample data.)

**Mac / command line:** `python3 -m polymm.scan.app`, or add `--offline` for the demo.

The dashboard rescans every 5 minutes (change this with `--interval 120`), or
whenever you click **Scan now**. Each opportunity is a card that explains in
plain English what to buy, where, at what price, and what you make, with links
straight to the markets. Cards are labelled **Locked profit**, **Check rules
first** or **Value bet**, and anything found since the last scan is marked
**NEW**. The page only runs on your own computer (127.0.0.1), and API keys stay
in the Python process; the page never sees them.

### Historical win rates (optional, one-time setup)

[Jon-Becker/prediction-market-analysis](https://github.com/Jon-Becker/prediction-market-analysis)
publishes the largest open dataset of resolved Kalshi and Polymarket trades. The
scanner can turn it into a small `calibration.json`: for each price, how often the
contracts bought at that price actually paid out. With that file present, the
scanner adds **Historical edge** cards: contracts trading below what history says
that price is worth (the favourite-longshot bias and similar). These are base
rates, not tips, so stakes are suggested at eighth-Kelly. Markets that
sportsbooks already price are left to the sportsbook signal.

1. Download `https://s3.jbecker.dev/data.tar.zst` in your browser. It's about
   36 GB; a browser can resume it if the connection drops.
2. Drag the downloaded file onto **`Build Calibration.bat`**. It streams through
   the archive without unpacking it, so you only need room for the download.
   Expect this to take a while.
3. When it finishes, `calibration.json` sits next to the `.bat`, and the
   dashboard uses it automatically. You can delete the 36 GB download.

On the command line: `pip install duckdb zstandard`, then
`python -m polymm.scan.calibrate --archive data.tar.zst`. Use `--data DIR`
instead if you've already extracted the dataset with that repo's `make setup`.

The scanner also borrows two smaller things from that repo: its Kalshi category
map (used for the category labels and filter, and for per-category win rates)
and its rate-limited, backoff-on-429 approach to API calls.

### Command line

Scans Polymarket and Kalshi (plus sportsbooks, if you have an Odds API key) and
ranks what it finds:

| Kind | What it is | Confidence |
|---|---|---|
| `cross_venue_arb` | The same question on both venues, where YES on one plus NO on the other costs less than $1 after fees | `arb` if the pair is in your mapping file, otherwise `needs-verification` |
| `multi_outcome_arb` | Mutually exclusive outcomes on one venue: the YES asks add up to less than $1, or the NO asks add up to less than $(n−1) | YES side: `needs-verification` unless the list is known to cover every outcome |
| `sportsbook_value` | A prediction market ask below the de-vigged sportsbook consensus, by more than both `min_value_edge` and 1.5σ | `model` |
| `cross_venue_value` | No locked profit, but one venue's ask is well below the other venue's mid | `model` / `needs-verification` |
| `calibration_value` | An ask below the historical win rate for contracts at that price, venue and category (needs `calibration.json`) | `model` |

```
python -m polymm.scan --offline                       # bundled sample snapshot
python -m polymm.scan --min-volume 5000 --max-days 30 # live scan
ODDS_API_KEY=... python -m polymm.scan --depth        # + sportsbooks + real book depth
python -m polymm.scan --mapping pairs.json --hide-unverified
python -m polymm.scan --watch 60 --webhook https://discord.com/api/webhooks/...
python -m polymm.scan --save-snapshot snap/ ; python -m polymm.scan --offline snap/
```

Arbs are ranked by annualized return, because a 2% lock that resolves tomorrow
beats a 4% lock that resolves next year. Value bets show quarter-Kelly sizing.

Things it is deliberately strict about:
- **Fees.** Kalshi's 0.07·P·(1−P) taker fee is included in every edge. Most thin
  "arbs" disappear once fees are counted; the bundled Oscars event is an example.
- **Fuzzy matches are never treated as arbs.** Two contracts can read the same and
  still resolve differently (price source, "by" vs "on", time zone, tie rules).
  Once you've read both rulebooks, add the pair to the mapping file
  (`polymm/scan/fixtures/mapping.json` shows the format).
- **Kalshi's NO side is not "the other team".** Kalshi's `no_sub_title` repeats the
  YES text, so NO on "Tampa Bay" is never treated as YES on Detroit.
- **Games that have started are skipped.** Once a game is live, a REST odds poll
  is too slow and its pre-game lines are stale.
- **Top-of-book size is small.** Use `--depth` to read the real order books and
  report how much you can actually fill at the quoted edge.

The parsers follow the 2026 API formats (Kalshi `*_dollars` strings, with the old
cent fields as a fallback; Polymarket Gamma `bestBid`/`bestAsk`/`negRisk`). The
live fetchers have only been checked against sample data so far: run one live
scan with `--save-snapshot` and check the output before trusting it.

### Useful open-source projects (review before running anything with keys)

- [Jon-Becker/prediction-market-analysis](https://github.com/Jon-Becker/prediction-market-analysis):
  historical trade dataset and calibration research; used for the Historical edge
  signal above (MIT licensed).
- [Polymarket/py-clob-client](https://github.com/Polymarket/py-clob-client) and
  [py-clob-client-v2](https://github.com/Polymarket/py-clob-client-v2): the
  official order placement clients, for executing what the scanner finds.
- [ImMike/polymarket-arbitrage](https://github.com/ImMike/polymarket-arbitrage):
  Polymarket/Kalshi arb monitor with a web UI and backtester. Worth reading for
  its market-matching approach.
- [realfishsam/prediction-market-arbitrage-bot](https://github.com/realfishsam/prediction-market-arbitrage-bot):
  built on the `pmxt` unified API (one interface for several venues).
- [CarlosIbCu/polymarket-kalshi-btc-arbitrage-bot](https://github.com/CarlosIbCu/polymarket-kalshi-btc-arbitrage-bot):
  narrow (hourly BTC markets) but a clean example of a fast arb loop.
- Avoid [joinQuantish/skills](https://github.com/joinQuantish/skills): it is
  unmaintained (the platform is shutting down), and it routes trades through
  Quantish-hosted servers and wallets.

## Going live

1. **Odds feed**: `feeds.py` parses The Odds API (`ODDS_API_KEY`). That's fine for
   pre-game. For live betting you need a push feed, because latency *is* the edge.
2. **Exchange**: `PolymarketExchange` wraps `py-clob-client`. The ask is placed as a
   BUY of the NO token at 1−ask, so you never need YES inventory. **Fills must be
   wired from Polymarket's user websocket into `MarketMaker.on_fill`; this isn't
   implemented yet.** The adapter is untested against the live API.
3. **Start small.** The default `RiskLimits` are in the hundreds of dollars on
   purpose. Run paper first, then live at tiny size. Check markouts and
   counterparty stats, and only then raise limits.
4. **Things to tune from your own data**: book weights (from closing-line value),
   correlation for same-game legs, `uncertainty_mult`, toxicity thresholds, and
   guard thresholds.

Not financial advice. Polymarket access and sports-betting legality depend on
where you are.
