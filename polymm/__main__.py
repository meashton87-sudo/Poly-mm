"""Worked example: quote the Bucs ML + Irving parlay.

    python -m polymm
"""

from __future__ import annotations

from .engine import MarketMaker, ParlayMarket
from .exchange import PaperExchange
from .fair_value import BookQuote, best_book_parlay_prob
from .odds import fmt_american
from .quoting import QuoteParams, make_quote

NOW = 1_000.0

# Two-way lines per book (our side first). Illustrative numbers.
LINES = {
    "bucs_ml": {
        "pinnacle": (+215, -238), "circa": (+210, -240), "fanduel": (+220, -270),
        "draftkings": (+210, -258), "hardrock": (+225, -275), "betmgm": (+200, -245),
    },
    "irving_over": {  # Kyrie Irving over 24.5 points
        "pinnacle": (+172, -190), "circa": (+170, -195), "fanduel": (+175, -215),
        "draftkings": (+165, -200), "hardrock": (+180, -220), "betmgm": (+160, -195),
    },
}
PARLAY_OFFERS = {"draftkings": +700, "hardrock": +799, "fanduel": +740}


def main() -> None:
    ex = PaperExchange()
    mm = MarketMaker(ex, [ParlayMarket("bucs_irving", ("bucs_ml", "irving_over"),
                                       "Bucs ML + Irving o24.5")])
    for p, a in PARLAY_OFFERS.items():
        mm.parlay_prices.setdefault("bucs_irving", {})[p] = a
    mm.on_book_quotes([BookQuote(b, leg, px, NOW - 2) for leg, books in LINES.items()
                       for b, px in books.items()], NOW)

    print("Leg fair values (de-vigged, weighted, outlier-checked):")
    for leg, est in mm.leg_est.items():
        print(f"  {leg:12s} p={est.p:.4f} ({fmt_american(est.p)})  "
              f"sigma={est.sigma_prob:.4f}  books={est.n_books} rejected={est.rejected}")
    f = mm.fairs["bucs_irving"]
    print(f"\nParlay fair: {f.p:.4f} = {fmt_american(f.p)}  (sigma {f.sigma_prob:.4f})")
    print("Book parlay offers: " + ", ".join(f"{b} {a:+d}" for b, a in PARLAY_OFFERS.items()))
    print("\nOur Polymarket quote:")
    print("  " + mm.status().replace("\n", "\n  "))

    fine = make_quote(f.p, f.sigma_prob, QuoteParams(tick=0.001),
                      best_book_prob=best_book_parlay_prob(list(PARLAY_OFFERS.values())))
    print(f"  (same model on a 0.001-tick market: {fine.describe()})")

    print("\n-- Injury news hits on Bucs QB --")
    mm.on_news("bucs_ml", NOW + 1, "Bucs QB questionable (news feed)")
    print("  " + mm.status().replace("\n", "\n  "))


if __name__ == "__main__":
    main()
