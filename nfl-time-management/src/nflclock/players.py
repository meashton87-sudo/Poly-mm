"""Who is on the field in each daily-game spot, and how good each player is.

Lineups come from nflverse snap counts (Pro Football Reference): for each team in each game, the
players with the most snaps at each position (QB, RB, three WRs, TE, two tackles, two guards, center;
the 11 defenders with the most snaps). Every player gets a league percentile at his position as of the
week of the game: this season's earlier weeks, plus last season at PRIOR_SEASON_WEIGHT, shrunk toward
the position average so a few good snaps don't make anyone elite.

  QB       EPA per dropback (nflverse play-by-play)
  RB       yards after contact per carry (PFR)
  WR, TE   EPA per target (play-by-play)
  OL       graded as a unit (no public data grades linemen one by one): pressure rate allowed and
           yards before contact per carry, each ranked among the 32 teams
  DL       pressures per snap (PFR pressures over snap counts); edge rushers (including linebackers
           who rush the passer) and interior linemen are ranked separately
  LB       tackles per snap, missed-tackle rate and passer rating allowed in coverage (PFR)
  CB       passer rating allowed when targeted (PFR)
  S        passer rating allowed when targeted and missed-tackle rate (PFR)
  K, P     the simulator's as-of kicker and punter ratings (field goals and net punting over expected)
"""
from __future__ import annotations

import urllib.request

import numpy as np
import pandas as pd

from . import config
from .playbook import PRIOR_SEASON_WEIGHT

RAW = config.RAW_DIR / "players"
BASE = "https://github.com/nflverse/nflverse-data/releases/download/"
FILES = {"snaps": ("snap_counts", "snap_counts_{s}.parquet"),
         "def": ("pfr_advstats", "advstats_week_def_{s}.parquet"),
         "pass": ("pfr_advstats", "advstats_week_pass_{s}.parquet"),
         "rush": ("pfr_advstats", "advstats_week_rush_{s}.parquet")}
# shrinkage: pseudo-observations of position-average play added to every player
K_QB, K_RB, K_REC, K_SNAPS, K_TGT_CB, K_TGT_LB, K_TGT_S, K_TACKLES = 150, 60, 40, 200, 30, 20, 20, 25
# the reference pool each percentile is ranked in: players with at least this much (weighted) volume
MIN_QB, MIN_RB, MIN_REC, MIN_SNAPS, MIN_TGT = 120, 60, 30, 150, 20
EDGE_LB_RATE = 0.025     # a linebacker with this many pressures per snap is an edge rusher, not an off-ball LB
DL_POS, LB_POS, CB_POS, S_POS = {"DE", "DT", "NT", "DL"}, {"LB", "ILB", "OLB", "MLB"}, {"CB", "DB"}, {"S", "FS", "SS"}
PFF_GROUP = {"ED": "EDGE", "DI": "DL", "LB": "LB", "CB": "CB", "S": "S"}


# ----------------------------------------------------------------- data ---
def _get(tag: str, name: str):
    RAW.mkdir(parents=True, exist_ok=True)
    p = RAW / name
    if not p.exists():
        urllib.request.urlretrieve(BASE + f"{tag}/{name}", p)
    return p


def load_tables(seasons) -> dict:
    out = {k: pd.concat([pd.read_parquet(_get(tag, pat.format(s=s))) for s in seasons], ignore_index=True)
           for k, (tag, pat) in FILES.items()}
    out["players"] = pd.read_parquet(_get("players", "players.parquet"),
                                     columns=["gsis_id", "pfr_id", "display_name", "position", "pff_position"])
    cols = ["season", "week", "season_type", "posteam", "play_type", "qb_dropback", "id", "qb_epa", "epa",
            "receiver_player_id", "two_point_attempt"]
    pbp = pd.concat([pd.read_parquet(config.RAW_DIR / f"play_by_play_{s}.parquet", columns=cols) for s in seasons],
                    ignore_index=True)
    out["pbp"] = pbp[pbp["two_point_attempt"].fillna(0) == 0]
    return out


def _w(df: pd.DataFrame, season: int, week: int) -> np.ndarray:
    return np.where(df["season"] == season, (df["week"] < week).astype(float),
                    np.where(df["season"] == season - 1, PRIOR_SEASON_WEIGHT, 0.0))


def _pct(values, pool, higher_better: bool = True) -> np.ndarray:
    """Share of the reference pool a value beats (ties count half)."""
    pool = np.sort(np.asarray(pool, float))
    values = np.asarray(values, float)
    if pool.size == 0:
        return np.full(values.shape, 0.5)
    p = (np.searchsorted(pool, values, "left") + np.searchsorted(pool, values, "right")) / 2 / pool.size
    return p if higher_better else 1 - p


def ordinal(n: int) -> str:
    return f"{n}{'th' if 11 <= n % 100 <= 13 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def passer_rating(att, cmp, yds, td, ints) -> np.ndarray:
    att = np.maximum(np.asarray(att, float), 1e-9)
    a = np.clip((cmp / att - 0.3) * 5, 0, 2.375)
    b = np.clip((yds / att - 3) * 0.25, 0, 2.375)
    c = np.clip(td / att * 20, 0, 2.375)
    d = np.clip(2.375 - ints / att * 25, 0, 2.375)
    return (a + b + c + d) / 6 * 100


# -------------------------------------------------------------- ratings ---
class Ratings:
    """Percentiles for every player and team unit as of (season, week); cached by week."""

    def __init__(self, tables: dict, bundle=None):
        self.T = tables
        self.bundle = bundle
        pl = tables["players"].dropna(subset=["pfr_id"])
        self.gsis_to_pfr = dict(zip(pl["gsis_id"], pl["pfr_id"]))
        self.pfr_pos = dict(zip(pl["pfr_id"], pl["position"]))
        # the role a player actually plays (PFR calls a 3-4 interior lineman a DE): edge, interior, ...
        self.role = {k: PFF_GROUP[v] for k, v in zip(pl["pfr_id"], pl["pff_position"]) if v in PFF_GROUP}
        self.cache = {}

    def week(self, season: int, week: int) -> dict:
        key = (season, week)
        if key not in self.cache:
            self.cache[key] = self._compute(season, week)
        return self.cache[key]

    # each block returns {pfr_id: (pct, stat line)} or {team: ...}
    def _compute(self, season, week) -> dict:
        T = self.T
        out = {"player": {}, "ol": {}, "grp": {}}
        snaps = T["snaps"].assign(w=lambda d: _w(d, season, week))
        snaps = snaps[snaps["w"] > 0]
        pos_mode = snaps.groupby("pfr_player_id")["position"].agg(lambda x: x.mode().iat[0])

        # QB: EPA per dropback
        pbp = T["pbp"].assign(w=lambda d: _w(d, season, week))
        pbp = pbp[pbp["w"] > 0]
        q = pbp[(pbp["qb_dropback"] == 1) & pbp["id"].notna() & pbp["qb_epa"].notna()]
        g = q.assign(we=q["w"] * q["qb_epa"]).groupby("id").agg(n=("w", "sum"), s=("we", "sum"), raw=("w", "size"))
        if len(g):
            m0 = g["s"].sum() / g["n"].sum()
            v = (g["s"] + K_QB * m0) / (g["n"] + K_QB)
            p = _pct(v, v[g["n"] >= MIN_QB])
            for gid, pp, r in zip(g.index, p, g.itertuples()):
                pfr = self.gsis_to_pfr.get(gid)
                if pfr:
                    out["player"][pfr] = (pp, f"EPA per dropback {r.s / r.n:+.2f} on {r.raw} dropbacks")

        # WR / TE: EPA per target
        t = pbp[(pbp["play_type"] == "pass") & pbp["receiver_player_id"].notna() & pbp["epa"].notna()]
        g = t.assign(we=t["w"] * t["epa"]).groupby("receiver_player_id").agg(n=("w", "sum"), s=("we", "sum"),
                                                                             raw=("w", "size"))
        g["pfr"] = g.index.map(self.gsis_to_pfr)
        g = g.dropna(subset=["pfr"])
        g["pos"] = g["pfr"].map(pos_mode).fillna(g["pfr"].map(self.pfr_pos))
        for grp in ("WR", "TE", "RB"):
            sub = g[g["pos"] == grp]
            if not len(sub):
                continue
            m0 = sub["s"].sum() / sub["n"].sum()
            v = (sub["s"] + K_REC * m0) / (sub["n"] + K_REC)
            p = _pct(v, v[sub["n"] >= MIN_REC])
            if grp == "RB":
                continue
            for pfr, pp, r in zip(sub["pfr"], p, sub.itertuples()):
                out["player"][pfr] = (pp, f"EPA per target {r.s / r.n:+.2f} on {r.raw} targets")

        # RB: yards after contact per carry
        ru = T["rush"].assign(w=lambda d: _w(d, season, week))
        ru = ru[(ru["w"] > 0) & (ru["carries"] > 0)]
        ru = ru.assign(pos=ru["pfr_player_id"].map(pos_mode).fillna(ru["pfr_player_id"].map(self.pfr_pos)))
        rb = ru[ru["pos"].isin(["RB", "FB"])]
        g = rb.assign(wc=rb["w"] * rb["carries"], wy=rb["w"] * rb["rushing_yards_after_contact"].fillna(0),
                      wb=rb["w"] * rb["rushing_broken_tackles"].fillna(0)).groupby("pfr_player_id").agg(
            n=("wc", "sum"), y=("wy", "sum"), bt=("wb", "sum"), raw=("carries", "sum"))
        if len(g):
            m0 = g["y"].sum() / g["n"].sum()
            v = (g["y"] + K_RB * m0) / (g["n"] + K_RB)
            p = _pct(v, v[g["n"] >= MIN_RB])
            for pfr, pp, r in zip(g.index, p, g.itertuples()):
                out["player"][pfr] = (pp, f"{r.y / r.n:.2f} yards after contact per carry on {int(r.raw)} carries")

        # OL as a unit: pressure rate allowed, yards before contact per carry (teams)
        pa = T["pass"].assign(w=lambda d: _w(d, season, week))
        pa = pa[pa["w"] > 0]
        pr = (pa["w"] * pa["times_pressured"].fillna(0)).groupby(pa["team"]).sum()
        db = pbp[pbp["qb_dropback"] == 1].groupby("posteam")["w"].sum()
        rate = (pr / db.reindex(pr.index)).dropna()
        ybc = (ru["w"] * ru["rushing_yards_before_contact"].fillna(0)).groupby(ru["team"]).sum() / \
            (ru["w"] * ru["carries"]).groupby(ru["team"]).sum()
        p_pass, p_run = _pct(rate, rate, higher_better=False), _pct(ybc, ybc)
        pp_pass, pp_run = dict(zip(rate.index, p_pass)), dict(zip(ybc.index, p_run))
        for team in set(pp_pass) | set(pp_run):
            a, b = pp_pass.get(team, 0.5), pp_run.get(team, 0.5)
            out["ol"][team] = ((a + b) / 2, f"Graded as a unit: pressure allowed on {rate.get(team, np.nan):.0%} of "
                                             f"dropbacks ({ordinal(round(a * 100))} pct), "
                                             f"{ybc.get(team, np.nan):.1f} yards before contact per carry "
                                             f"({ordinal(round(b * 100))} pct)")

        # defense: PFR stats on top of snap counts
        de = T["def"].assign(w=lambda d: _w(d, season, week))
        de = de[de["w"] > 0]
        dsn = snaps[snaps["defense_snaps"] > 0][["game_id", "pfr_player_id", "defense_snaps", "w"]]
        stat_cols = ["def_pressures", "def_tackles_combined", "def_missed_tackles", "def_targets",
                     "def_completions_allowed", "def_yards_allowed", "def_receiving_td_allowed", "def_ints", "def_sacks"]
        d = dsn.merge(de[["game_id", "pfr_player_id"] + stat_cols], on=["game_id", "pfr_player_id"], how="left")
        d[stat_cols] = d[stat_cols].fillna(0)
        gr = d.groupby("pfr_player_id")[["defense_snaps"] + stat_cols].sum()   # unweighted, for the stat lines
        for c in ["defense_snaps"] + stat_cols:
            d[c] = d[c] * d["w"]
        g = d.groupby("pfr_player_id")[["defense_snaps"] + stat_cols].sum()
        ids = pd.Series(g.index, index=g.index)
        g["pos"] = ids.map(pos_mode).fillna(ids.map(self.pfr_pos))
        g["press"] = g["def_pressures"] / g["defense_snaps"].clip(lower=1)
        role = ids.map(self.role)
        guess = np.where(g["pos"].isin(["DE", "OLB"]) | (g["pos"].isin(LB_POS) & (g["press"] >= EDGE_LB_RATE)
                                                          & (g["defense_snaps"] >= 100)), "EDGE",
                         np.where(g["pos"].isin(["DT", "NT", "DL"]), "DL", np.where(g["pos"].isin(LB_POS), "LB",
                                  np.where(g["pos"].isin(CB_POS), "CB", np.where(g["pos"].isin(S_POS), "S", "X")))))
        g["grp"] = role.fillna(pd.Series(guess, index=g.index))
        edge, interior = g["grp"] == "EDGE", g["grp"] == "DL"
        out["grp"] = g["grp"].to_dict()
        for mask, label in ((edge, "edge"), (interior, "interior")):
            sub = g[mask]
            if not len(sub):
                continue
            m0 = sub["def_pressures"].sum() / sub["defense_snaps"].sum()
            v = (sub["def_pressures"] + K_SNAPS * m0) / (sub["defense_snaps"] + K_SNAPS)
            p = _pct(v, v[sub["defense_snaps"] >= MIN_SNAPS])
            for pfr, pp in zip(sub.index, p):
                r = gr.loc[pfr]
                out["player"][pfr] = (pp, f"{r.def_pressures:.0f} pressures and {r.def_sacks:g} sacks in "
                                          f"{r.defense_snaps:.0f} snaps")

        def coverage(sub, k):
            tg = sub["def_targets"]
            rates = [sub[c].sum() / max(tg.sum(), 1) for c in ("def_completions_allowed", "def_yards_allowed",
                                                                "def_receiving_td_allowed", "def_ints")]
            return passer_rating(tg + k, sub["def_completions_allowed"] + k * rates[0], sub["def_yards_allowed"] + k * rates[1],
                                 sub["def_receiving_td_allowed"] + k * rates[2], sub["def_ints"] + k * rates[3])

        def missed(sub, k):
            tot = sub["def_tackles_combined"] + sub["def_missed_tackles"]
            m0 = sub["def_missed_tackles"].sum() / max(tot.sum(), 1)
            return (sub["def_missed_tackles"] + k * m0) / (tot + k)

        lb = g[g["grp"] == "LB"]
        if len(lb):
            pool = lb["defense_snaps"] >= MIN_SNAPS
            tk = (lb["def_tackles_combined"] + K_SNAPS * (lb["def_tackles_combined"].sum() / lb["defense_snaps"].sum())) / (
                lb["defense_snaps"] + K_SNAPS)
            cov, mt = coverage(lb, K_TGT_LB), missed(lb, K_TACKLES)
            p = (_pct(tk, tk[pool]) + _pct(mt, mt[pool], False) + _pct(cov, cov[pool], False)) / 3
            lr = gr.loc[lb.index]
            raw_cov = passer_rating(lr["def_targets"], lr["def_completions_allowed"], lr["def_yards_allowed"],
                                    lr["def_receiving_td_allowed"], lr["def_ints"])
            for pfr, pp, r, rc in zip(lb.index, p, lr.itertuples(), raw_cov):
                miss = r.def_missed_tackles / max(r.def_tackles_combined + r.def_missed_tackles, 1)
                out["player"][pfr] = (pp, f"{r.def_tackles_combined:.0f} tackles in {r.defense_snaps:.0f} snaps, "
                                          f"missed {miss:.0%}, passer rating allowed {rc:.0f} in coverage")
        for k, label in ((K_TGT_CB, "CB"), (K_TGT_S, "S")):
            sub = g[g["grp"] == label]
            if not len(sub):
                continue
            pool = sub["def_targets"] >= MIN_TGT
            cov = coverage(sub, k)
            p = _pct(cov, cov[pool], False)
            if label == "S":
                mt = missed(sub, K_TACKLES)
                p = (p + _pct(mt, mt[sub["defense_snaps"] >= MIN_SNAPS], False)) / 2
            sr = gr.loc[sub.index]
            raw_cov = passer_rating(sr["def_targets"], sr["def_completions_allowed"], sr["def_yards_allowed"],
                                    sr["def_receiving_td_allowed"], sr["def_ints"])
            for pfr, pp, r, rc in zip(sub.index, p, sr.itertuples(), raw_cov):
                out["player"][pfr] = (pp, f"Passer rating allowed {rc:.0f} on {r.def_targets:.0f} targets, "
                                          f"{r.def_ints:.0f} INT, {r.def_receiving_td_allowed:.0f} TD allowed")

        # kickers and punters: the simulator's as-of ratings, ranked among that week's specialists
        out["k"], out["p"] = {}, {}
        if self.bundle is not None:
            for name, tab, key in (("k", self.bundle.kicker_ratings, "kicker_player_id"),
                                   ("p", self.bundle.punter_ratings, "punter_player_id")):
                wk = tab[(tab["season"] == season) & (tab["week"] == week)]
                if len(wk):
                    out[name] = dict(zip(wk[key], _pct(wk["rating"], wk["rating"])))
        return out


# -------------------------------------------------------------- lineups ---
def _allocate(expected: dict, total: int, avail: dict) -> dict:
    """Split `total` places among groups in proportion to how many of each were on the field on an average
    snap (largest remainder), never more than a group has players."""
    exp = {k: max(v, 0.0) for k, v in expected.items() if avail.get(k, 0) > 0}
    out = {k: min(int(np.floor(v)), avail[k]) for k, v in exp.items()}
    while sum(out.values()) < total:
        open_ = [k for k in exp if out[k] < avail[k]]
        if not open_:
            break
        k = max(open_, key=lambda k: exp[k] - out[k])
        out[k] += 1
    while sum(out.values()) > total:
        k = min((k for k in out if out[k] > 0), key=lambda k: exp[k] - out[k])
        out[k] -= 1
    return out


def lineup(R: Ratings, game_id: str, team: str, season: int, week: int) -> dict:
    """The 11 on offense and 11 on defense for `team` in `game_id`: the personnel each side used most
    (expected players per position group on an average snap), filled with the players who took the most
    snaps at each position; percentiles as of the week of the game."""
    sn = R.T["snaps"]
    g = sn[(sn["game_id"] == game_id) & (sn["team"] == team)]
    rt = R.week(season, week)

    def rec(row, label):
        pct, stat = rt["player"].get(row.pfr_player_id, (None, None))
        if pct is None:
            pct, stat = 0.5, "Not enough snaps in the data yet: shown at the league median"
        return {"pos": label, "name": row.player, "pct": int(round(float(pct) * 100)), "stat": stat}

    off = g[g["offense_snaps"] > 0].sort_values("offense_snaps", ascending=False)
    offense, used = [], set()
    for row in off[off["position"] == "QB"].head(1).itertuples():
        used.add(row.pfr_player_id)
        offense.append(rec(row, "QB"))
    ol_pool = off[off["position"].isin(["T", "G", "C", "OL"])]
    for pos, k in (("T", 2), ("G", 2), ("C", 1)):
        cand = ol_pool[(ol_pool["position"] == pos) & ~ol_pool["pfr_player_id"].isin(used)]
        if len(cand) < k:
            cand = pd.concat([cand, ol_pool[~ol_pool["pfr_player_id"].isin(used) & ~ol_pool["pfr_player_id"].isin(cand["pfr_player_id"])]])
        for row in cand.head(k).itertuples():
            used.add(row.pfr_player_id)
            pct, stat = rt["ol"].get(team, (0.5, "Graded as a unit: no data yet"))
            offense.append({"pos": pos, "name": row.player, "pct": int(round(pct * 100)), "stat": stat})
    skill = off[off["position"].isin(["RB", "FB", "WR", "TE"]) & ~off["pfr_player_id"].isin(used)].copy()
    skill["grp"] = skill["position"].replace({"FB": "RB"})
    n_skill = 11 - len(offense)
    alloc = _allocate(skill.groupby("grp")["offense_pct"].sum().to_dict(), n_skill, skill["grp"].value_counts().to_dict())
    for grp in ("RB", "WR", "TE"):
        for row in skill[skill["grp"] == grp].head(alloc.get(grp, 0)).itertuples():
            used.add(row.pfr_player_id)
            offense.append(rec(row, grp))
    for row in off[~off["pfr_player_id"].isin(used)].itertuples():   # still short: the next most-used players
        if len(offense) >= 11:
            break
        used.add(row.pfr_player_id)
        offense.append(rec(row, row.position if row.position in ("QB", "RB", "WR", "TE") else "WR"))

    dfn = g[g["defense_snaps"] > 0].sort_values("defense_snaps", ascending=False).copy()
    dfn["grp"] = [R.role.get(pid) or rt["grp"].get(pid) or ("DL" if p in DL_POS else "LB" if p in LB_POS else "CB" if p in CB_POS
                  else "S" if p in S_POS else "X") for p, pid in zip(dfn["position"], dfn["pfr_player_id"])]
    dfn = dfn[dfn["grp"] != "X"]
    alloc = _allocate(dfn.groupby("grp")["defense_pct"].sum().to_dict(), 11, dfn["grp"].value_counts().to_dict())
    defense = []
    for grp in ("EDGE", "DL", "LB", "CB", "S"):
        for row in dfn[dfn["grp"] == grp].head(alloc.get(grp, 0)).itertuples():
            defense.append(rec(row, grp))
    return {"off": offense, "def": defense}


def specialist_pct(R: Ratings, season: int, week: int, kind: str, gsis_id) -> int:
    v = R.week(season, week)[kind].get(gsis_id)
    return int(round(v * 100)) if v is not None else 50
