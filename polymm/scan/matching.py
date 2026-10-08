"""Pairing the same question across venues, and teams across books.

Fuzzy matching only *proposes* pairs. Two contracts that read alike can
resolve differently (different source, deadline, "by" vs "on", tie rules), so
fuzzy pairs are reported as `needs-verification`. Pairs you've checked go in
a mapping file and are reported as confirmed.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from .models import Contract

_STOP = {
    "will", "the", "be", "a", "an", "of", "in", "on", "to", "by", "at", "for", "and", "or",
    "before", "after", "end", "yes", "no", "market", "price", "reach", "hit", "above", "below",
    "than", "more", "less", "is", "vs", "v", "win", "wins", "who", "what", "which",
}
_NUM = re.compile(r"\d+(?:\.\d+)?")


def _norm_numbers(text: str) -> str:
    t = text.lower().replace(",", "")
    t = re.sub(r"(\d+(?:\.\d+)?)\s*k\b", lambda m: str(int(float(m.group(1)) * 1000)), t)
    return t


def tokens(text: str) -> set[str]:
    t = _norm_numbers(text)
    words = re.findall(r"[a-z]+|\d+(?:\.\d+)?", t)
    return {w for w in words if w not in _STOP}


def similarity(a: Contract, b: Contract) -> float:
    ta = tokens(f"{a.title} {a.outcome if a.outcome not in ('Yes',) else ''}")
    tb = tokens(f"{b.title} {b.outcome if b.outcome not in ('Yes',) else ''}")
    if not ta or not tb:
        return 0.0
    j = len(ta & tb) / len(ta | tb)
    na, nb = {t for t in ta if _NUM.fullmatch(t)}, {t for t in tb if _NUM.fullmatch(t)}
    if na != nb:
        # Different thresholds/dates are different questions. Heavy penalty.
        j *= 0.3
    if a.close_time and b.close_time:
        days = abs((a.close_time - b.close_time).total_seconds()) / 86400
        if days > 7:
            j *= 0.5
    return j


@dataclass
class Pair:
    a: Contract
    b: Contract
    score: float
    confirmed: bool = False
    inverted: bool = False  # b's YES == a's NO


def load_mapping(path: str | Path) -> list[dict]:
    """[{"polymarket": "<condition id>", "kalshi": "<ticker>", "inverted": false}, ...]"""
    return json.loads(Path(path).read_text())


def match_cross_venue(contracts: list[Contract], mapping: list[dict] | None = None,
                      threshold: float = 0.6) -> list[Pair]:
    by_key = {c.key: c for c in contracts}
    pairs: list[Pair] = []
    used: set[str] = set()
    for row in mapping or []:
        a, b = by_key.get(f"polymarket:{row['polymarket']}"), by_key.get(f"kalshi:{row['kalshi']}")
        if a and b:
            pairs.append(Pair(a, b, 1.0, confirmed=True, inverted=bool(row.get("inverted"))))
            used |= {a.key, b.key}

    poly = [c for c in contracts if c.venue == "polymarket" and c.key not in used]
    kal = [c for c in contracts if c.venue == "kalshi" and c.key not in used]
    index: dict[str, list[Contract]] = {}
    for k in kal:  # cheap blocking: only compare contracts sharing a rare-ish token
        for t in tokens(k.title):
            index.setdefault(t, []).append(k)
    for p in poly:
        cands = {id(k): k for t in tokens(p.title) for k in index.get(t, [])[:200]}
        best, best_s = None, threshold
        for k in cands.values():
            s = similarity(p, k)
            if s >= best_s:
                best, best_s = k, s
        if best is not None and best.key not in used:
            pairs.append(Pair(p, best, best_s))
            used.add(best.key)
    return pairs


def team_matches(label: str, full_name: str) -> bool:
    """'Buccaneers' / 'Tampa Bay' / 'TB Buccaneers' vs 'Tampa Bay Buccaneers'.

    Whole-word matching only: 'LA' must not match 'Atlanta'.
    """
    a = re.findall(r"[a-z0-9]+", label.lower())
    b = re.findall(r"[a-z0-9]+", full_name.lower())
    if not a or not b:
        return False
    if a == b or set(a) <= set(b) or set(b) <= set(a):
        return True
    return a[-1] == b[-1] and len(a[-1]) > 3  # shared nickname
