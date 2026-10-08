"""Parlay (conjunction of legs) fair value with correlation.

Correlation is modelled with a Gaussian copula: each leg i hits when a latent
standard normal Z_i < Phi^-1(p_i), and the Z's have correlation matrix R.
- Cross-sport / different games (Bucs + Irving): rho = 0, parlay = product.
- Same-game legs (QB overs + team ML): rho > 0, parlay > product. Books know
  this and price SGPs accordingly; if you quote the product you get picked off.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from statistics import NormalDist
from typing import Mapping, Sequence

from .fair_value import FairEstimate

_N = NormalDist()

Pair = tuple[str, str]


def _pair(a: str, b: str) -> Pair:
    return (a, b) if a <= b else (b, a)


def bivariate_normal_cdf(a: float, b: float, rho: float, steps: int = 200) -> float:
    """P(Z1 < a, Z2 < b) for standard normals with correlation rho.

    Uses Phi2 = Phi(a)Phi(b) + integral_0^rho phi2(a, b; r) dr (Simpson's rule).
    """
    base = _N.cdf(a) * _N.cdf(b)
    if rho == 0:
        return base
    rho = max(min(rho, 0.9999), -0.9999)
    if steps % 2:
        steps += 1
    h = rho / steps

    def f(r: float) -> float:
        one_m = 1 - r * r
        return math.exp(-(a * a - 2 * r * a * b + b * b) / (2 * one_m)) / (2 * math.pi * math.sqrt(one_m))

    s = f(0) + f(rho)
    for i in range(1, steps):
        s += (4 if i % 2 else 2) * f(i * h)
    return base + s * h / 3


def _cholesky(m: list[list[float]]) -> list[list[float]]:
    n = len(m)
    L = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1):
            s = m[i][j] - sum(L[i][k] * L[j][k] for k in range(j))
            if i == j:
                if s <= 0:
                    raise ValueError("correlation matrix is not positive definite")
                L[i][j] = math.sqrt(s)
            else:
                L[i][j] = s / L[j][j]
    return L


def corr_matrix(leg_ids: Sequence[str], corr: Mapping[Pair, float]) -> list[list[float]]:
    return [
        [1.0 if a == b else corr.get(_pair(a, b), 0.0) for b in leg_ids] for a in leg_ids
    ]


def sample_outcomes(
    leg_ids: Sequence[str], probs: Sequence[float], corr: Mapping[Pair, float],
    n: int, seed: int = 7,
) -> list[tuple[bool, ...]]:
    """Monte Carlo joint leg outcomes under the Gaussian copula."""
    rng = random.Random(seed)
    L = _cholesky(corr_matrix(leg_ids, corr))
    thresholds = [_N.inv_cdf(p) for p in probs]
    k = len(leg_ids)
    out = []
    for _ in range(n):
        e = [rng.gauss(0, 1) for _ in range(k)]
        z = [sum(L[i][j] * e[j] for j in range(i + 1)) for i in range(k)]
        out.append(tuple(z[i] < thresholds[i] for i in range(k)))
    return out


def joint_prob(
    leg_ids: Sequence[str], probs: Sequence[float], corr: Mapping[Pair, float] | None = None,
    mc_samples: int = 100_000,
) -> float:
    corr = corr or {}
    rhos = [corr.get(_pair(a, b), 0.0) for i, a in enumerate(leg_ids) for b in leg_ids[i + 1:]]
    if not any(rhos):
        return math.prod(probs)
    if len(leg_ids) == 2:
        return bivariate_normal_cdf(_N.inv_cdf(probs[0]), _N.inv_cdf(probs[1]), rhos[0])
    hits = sum(all(o) for o in sample_outcomes(leg_ids, probs, corr, mc_samples))
    return hits / mc_samples


@dataclass
class ParlayFair:
    p: float
    sigma_prob: float
    legs: list[FairEstimate]
    independent_p: float  # product of legs, for reference
    corr_adjustment: float = field(default=0.0)

    @property
    def ok(self) -> bool:
        return all(l.ok for l in self.legs) and 0 < self.p < 1


def parlay_fair(
    legs: Sequence[FairEstimate],
    corr: Mapping[Pair, float] | None = None,
    corr_sigma: float = 0.1,
) -> ParlayFair:
    """Combine leg fair values into a parlay fair value and an uncertainty.

    sigma combines (a) leg estimation error, propagated through
    d log(P)/d logit(p_i) = (1 - p_i), and (b) correlation model risk: how much
    P moves if each non-zero rho is off by +/- corr_sigma.
    """
    corr = corr or {}
    if not all(l.ok for l in legs):
        return ParlayFair(float("nan"), float("inf"), list(legs), float("nan"))

    ids = [l.leg_id for l in legs]
    ps = [l.p for l in legs]
    p = joint_prob(ids, ps, corr)
    indep = math.prod(ps)

    var_logp = sum(((1 - l.p) * l.sigma_logit) ** 2 for l in legs)
    sigma = p * math.sqrt(var_logp)

    if any(corr.get(_pair(a, b), 0.0) for i, a in enumerate(ids) for b in ids[i + 1:]):
        bump = lambda d: {k: max(min(v + d, 0.99), -0.99) for k, v in corr.items()}
        hi, lo = joint_prob(ids, ps, bump(corr_sigma)), joint_prob(ids, ps, bump(-corr_sigma))
        sigma = math.sqrt(sigma**2 + ((hi - lo) / 2) ** 2)

    return ParlayFair(p=p, sigma_prob=sigma, legs=list(legs), independent_p=indep,
                      corr_adjustment=p - indep)
