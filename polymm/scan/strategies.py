"""The four ways the scanner finds value.

1. multi_outcome_arb   one venue, mutually exclusive outcomes priced wrong as a set
                       (YES asks sum < 1, or NO asks sum < n - 1)
2. cross_venue_arb     same question on Polymarket and Kalshi: YES here + NO there < $1
3. cross_venue_value   no lock, but one venue's ask is well below the other's mid
4. sportsbook_value    prediction-market ask below de-vigged sportsbook consensus
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Iterable

from ..fair_value import BookQuote, FairValueConfig, estimate_leg
from .fees import FeeModel
from .matching import Pair, team_matches
from .models import Contract, Leg, Opportunity
from .sources import _dt


@dataclass
class ScanConfig:
    min_arb_edge: float = 0.005  # $ per $1 unit after fees
    min_value_edge: float = 0.02  # value trades need more cushion than arbs
    value_sigma_mult: float = 1.5  # ... and must beat model uncertainty
    min_price: float = 0.02  # ignore dust-priced longshots
    max_price: float = 0.98
    include_indicative: bool = False  # trade on mid/last prices? (no)
    max_days: float | None = None  # skip things resolving too far out


def _days(cs: Iterable[Contract], now: datetime) -> float | None:
    ts = [c.close_time for c in cs if c.close_time]
    return max((t - now).total_seconds() / 86400 for t in ts) if ts else None


def _leg(c: Contract, side: str, fees: FeeModel) -> Leg | None:
    px = c.ask(side)
    if px is None or not (0 < px < 1):
        return None
    return Leg(c, side, px, fees.per_contract(c.venue, px))


def _size(c: Contract, side: str) -> float | None:
    return c.yes_ask_size if side == "YES" else c.yes_bid_size


def _min_size(legs: list[Leg]) -> float | None:
    sizes = [_size(l.contract, l.side) for l in legs]
    return None if any(s is None for s in sizes) else min(sizes)


# ------------------------------------------------------------------ 1. multi-outcome

def multi_outcome_arbs(contracts: list[Contract], fees: FeeModel, cfg: ScanConfig,
                       now: datetime) -> list[Opportunity]:
    groups: dict[tuple[str, str], list[Contract]] = {}
    for c in contracts:
        if c.group and (cfg.include_indicative or not c.indicative):
            groups.setdefault((c.venue, c.group), []).append(c)
    out = []
    for (venue, _), cs in groups.items():
        if len(cs) < 2:
            continue
        n = len(cs)
        title = cs[0].group_title or cs[0].title
        for side, payout in (("YES", 1.0), ("NO", n - 1.0)):
            legs = [_leg(c, side, fees) for c in cs]
            if any(l is None for l in legs):
                continue
            cost = sum(l.price + l.fee for l in legs)
            edge = payout - cost
            if edge < cfg.min_arb_edge:
                continue
            notes = [f"{n} outcomes on {venue}; buy every {side}"]
            conf = "arb"
            if side == "YES" and cs[0].exhaustive is not True:
                conf = "needs-verification"
                notes.append("only locked if one listed outcome MUST happen (check for 'Other'/none)")
            if side == "NO":
                notes.append(f"pays >= ${payout:.0f} if at most one outcome occurs")
            out.append(Opportunity("multi_outcome_arb", title, legs, edge, cost, confidence=conf,
                                   days_to_close=_days(cs, now), max_units=_min_size(legs), notes=notes))
    return out


# ------------------------------------------------------------------ 2/3. cross-venue

def cross_venue(pairs: list[Pair], fees: FeeModel, cfg: ScanConfig, now: datetime) -> list[Opportunity]:
    out = []
    for pr in pairs:
        a, b = pr.a, pr.b
        if not cfg.include_indicative and (a.indicative or b.indicative):
            continue
        combos = ([("YES", "YES"), ("NO", "NO")] if pr.inverted else [("YES", "NO"), ("NO", "YES")])
        conf = "arb" if pr.confirmed else "needs-verification"
        note = "confirmed mapping" if pr.confirmed else f"fuzzy match (score {pr.score:.2f}): CHECK BOTH RULEBOOKS"
        found_arb = False
        for sa, sb in combos:
            la, lb = _leg(a, sa, fees), _leg(b, sb, fees)
            if la is None or lb is None:
                continue
            cost = la.price + la.fee + lb.price + lb.fee
            edge = 1 - cost
            if edge >= cfg.min_arb_edge:
                found_arb = True
                out.append(Opportunity("cross_venue_arb", a.title, [la, lb], edge, cost, confidence=conf,
                                       days_to_close=_days([a, b], now), max_units=_min_size([la, lb]),
                                       notes=[note, f"Kalshi: {b.title} [{b.outcome}]"]))
        if found_arb:
            continue
        # Soft value: buy on one venue below the other venue's mid.
        for buy, ref, inv in ((a, b, pr.inverted), (b, a, pr.inverted)):
            ref_mid = ref.mid
            if ref_mid is None:
                continue
            fair_yes = 1 - ref_mid if inv else ref_mid
            for side, fair in (("YES", fair_yes), ("NO", 1 - fair_yes)):
                l = _leg(buy, side, fees)
                if l is None or not (cfg.min_price <= l.price <= cfg.max_price):
                    continue
                edge = fair - l.price - l.fee
                if edge >= cfg.min_value_edge:
                    out.append(Opportunity("cross_venue_value", buy.title, [l], edge, l.price + l.fee,
                                           fair=fair, confidence="model" if pr.confirmed else "needs-verification",
                                           days_to_close=_days([buy], now), max_units=_min_size([l]),
                                           notes=[note, f"fair = {ref.venue} mid {ref_mid:.3f}"]))
    return out


# ------------------------------------------------------------------ 4. sportsbooks

def _options(contracts: list[Contract]) -> list[tuple[Contract, str, str]]:
    """(contract, side, label) for every buyable side with a team-like label."""
    out = []
    for c in contracts:
        if c.outcome.lower() not in ("yes", "no"):
            out.append((c, "YES", c.outcome))
        if c.no_is_named_outcome:
            out.append((c, "NO", c.no_label))
    return out


def sportsbook_value(contracts: list[Contract], odds_events: list[dict], fees: FeeModel,
                     cfg: ScanConfig, now: datetime,
                     fv: FairValueConfig | None = None) -> list[Opportunity]:
    fv = fv or FairValueConfig(max_quote_age=6 * 3600, recency_half_life=3600, min_books=3)
    opts = _options(contracts)
    out = []
    t_now = now.timestamp()
    for ev in odds_events:
        start = _dt(ev.get("commence_time"))
        if start is None or start <= now:
            continue  # live: pre-game lines are stale and PM moves faster than a REST poll
        teams = [ev.get("home_team", ""), ev.get("away_team", "")]
        # Collect every book's h2h line as {outcome name: american price}.
        lines: list[tuple[str, float, dict[str, float]]] = []
        for bm in ev.get("bookmakers", []):
            for mk in bm.get("markets", []):
                if mk.get("key") == "h2h":
                    ts = _dt(mk.get("last_update") or bm.get("last_update"))
                    lines.append((bm["key"], ts.timestamp() if ts else t_now,
                                  {o["name"]: float(o["price"]) for o in mk.get("outcomes", [])}))
        if not lines:
            continue
        names = sorted({n for _, _, d in lines for n in d})
        for name in names:
            others = [n for n in names if n != name]
            quotes = [BookQuote(b, name, (d[name],) + tuple(d[o] for o in others), min(ts, t_now))
                      for b, ts, d in lines if name in d and all(o in d for o in others)]
            est = estimate_leg(name, quotes, t_now, fv)
            if not est.ok:
                continue
            opp = next((t for t in teams if t != name), "")
            for c, side, label in opts:
                if not team_matches(label, name):
                    continue
                # The contract must be about THIS game: opponent named, date close.
                ctx = f"{c.title} {c.outcome} {c.no_label} {c.group_title}"
                if not opp or not any(team_matches(w, opp) for w in _candidate_names(ctx, opp)):
                    continue
                if c.close_time and abs((c.close_time - start).total_seconds()) > 4 * 86400:
                    continue
                if c.indicative and not cfg.include_indicative:
                    continue
                l = _leg(c, side, fees)
                if l is None or not (cfg.min_price <= l.price <= cfg.max_price):
                    continue
                edge = est.p - l.price - l.fee
                if edge >= max(cfg.min_value_edge, cfg.value_sigma_mult * est.sigma_prob):
                    out.append(Opportunity(
                        "sportsbook_value", f"{ev.get('away_team')} @ {ev.get('home_team')}", [l],
                        edge, l.price + l.fee, fair=est.p, confidence="model",
                        days_to_close=(start - now).total_seconds() / 86400, max_units=_min_size([l]),
                        notes=[f"{name}: de-vigged fair {est.p:.3f} ± {est.sigma_prob:.3f} "
                               f"from {est.n_books} books ({', '.join(est.books_used[:5])})"]))
    return out


def _candidate_names(text: str, opp: str) -> list[str]:
    """Substrings of `text` worth testing against the opponent's name."""
    words = text.split()
    k = len(opp.split())
    return [" ".join(words[i:i + n]) for n in range(1, k + 1) for i in range(len(words) - n + 1)]
