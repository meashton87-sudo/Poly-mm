# poly-mm

A Polymarket parlay market maker built around one idea: **take fair value from the
sportsbooks, quote around it, and above all don't get run over.**

```
python -m polymm          # worked example: Bucs ML + Irving o24.5
python -m polymm.sim      # Monte Carlo: naive vs protected market maker
python -m pytest          # 31 tests
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
