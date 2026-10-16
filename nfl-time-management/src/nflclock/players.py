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

import urllib.error
import urllib.request

import numpy as np
import pandas as pd

from . import config
from .playbook import PRIOR_SEASON_WEIGHT

RAW = config.RAW_DIR / "players"
BASE = "https://github.com/nflverse/nflverse-data/releases/download/"
SCHEMA_SEASON = 2025     # when no season asked for has a file (PFR charting starts in 2018), this season's gives the columns
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
def _get(tag: str, name: str, optional: bool = False):
    """The nflverse release file, downloaded once; None when it is not published and `optional` (noted, so it is
    not asked for again)."""
    RAW.mkdir(parents=True, exist_ok=True)
    p = RAW / name
    if not p.exists():
        if optional and p.with_suffix(p.suffix + ".missing").exists():
            return None
        tmp = p.with_suffix(p.suffix + ".part")
        try:
            urllib.request.urlretrieve(BASE + f"{tag}/{name}", tmp)
        except urllib.error.HTTPError as e:
            if optional and e.code == 404:
                p.with_suffix(p.suffix + ".missing").touch()
                return None
            raise
        tmp.replace(p)
    return p


def read_seasons(tag: str, pattern: str, seasons, columns=None) -> pd.DataFrame:
    """The seasons' files as one frame, skipping seasons not published (PFR charting starts in 2018); none at all gives
    an empty frame with SCHEMA_SEASON's columns, so every stat reads as zero."""
    frames = [pd.read_parquet(f, columns=columns) for f in (_get(tag, pattern.format(s=s), optional=True) for s in seasons) if f is not None]
    if frames:
        return pd.concat(frames, ignore_index=True)
    return pd.read_parquet(_get(tag, pattern.format(s=SCHEMA_SEASON)), columns=columns).iloc[0:0]


FIRST_SEASON = 1999      # nflverse play-by-play starts here


def pbp_seasons(seasons):
    """The seasons with play-by-play among `seasons` (none before FIRST_SEASON)."""
    return [s for s in seasons if s >= FIRST_SEASON]


def pbp_path(season: int):
    """The season's play-by-play file, downloaded when it is not there yet."""
    if season < FIRST_SEASON:
        raise ValueError(f"no play-by-play before {FIRST_SEASON} ({season})")
    p = config.RAW_DIR / f"play_by_play_{season}.parquet"
    if not p.exists():
        from . import data
        data.download([season])
    return p


def load_tables(seasons) -> dict:
    out = {k: read_seasons(tag, pat, seasons) for k, (tag, pat) in FILES.items()}
    out["players"] = pd.read_parquet(_get("players", "players.parquet"),
                                     columns=["gsis_id", "pfr_id", "display_name", "position", "pff_position"])
    cols = ["season", "week", "season_type", "posteam", "play_type", "qb_dropback", "id", "qb_epa", "epa",
            "receiver_player_id", "two_point_attempt", "game_id", "passer_player_id", "rusher_player_id"]
    pbp = pd.concat([pd.read_parquet(pbp_path(s), columns=cols) for s in pbp_seasons(seasons)], ignore_index=True)
    out["snaps"] = fix_snap_teams(out["snaps"], out["players"], pbp)
    out["pbp"] = pbp[pbp["two_point_attempt"].fillna(0) == 0]
    return out


def fix_snap_teams(snaps: pd.DataFrame, players: pd.DataFrame, pbp: pd.DataFrame) -> pd.DataFrame:
    """The snap counts with each game's teams the right way round: PFR's file has some (Super Bowls XLIX, 50 and LIII,
    neutral sites) with each team's players under the other's name. A team's offensive players are the ones who
    passed, ran and caught for it in the play-by-play; a game whose two lists match the other team better is
    swapped back."""
    if not len(snaps) or "game_id" not in pbp:
        return snaps
    pfr2g = dict(zip(players["pfr_id"], players["gsis_id"]))
    ids = pd.concat([pbp[["game_id", "posteam", c]].rename(columns={c: "id"}) for c in
                     ("passer_player_id", "rusher_player_id", "receiver_player_id")]).dropna()
    own = set(zip(ids["game_id"], ids["posteam"], ids["id"]))
    off = snaps[snaps["offense_snaps"].fillna(0) > 0]
    swap = set()
    for gid, g in off.groupby("game_id"):
        same = other = 0
        for t, o, pid in zip(g["team"], g["opponent"], g["pfr_player_id"]):
            x = pfr2g.get(pid)
            if x:
                same += (gid, t, x) in own
                other += (gid, o, x) in own
        if other > same:
            swap.add(gid)
    if not swap:
        return snaps
    m = snaps["game_id"].isin(swap)
    out = snaps.copy()
    out.loc[m, ["team", "opponent"]] = snaps.loc[m, ["opponent", "team"]].to_numpy()
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


def count(n, one: str, many: str | None = None) -> str:
    """'1 sack', '5.5 sacks', '0 sacks'."""
    s = f"{n:g}" if isinstance(n, float) and not float(n).is_integer() else f"{n:.0f}"
    return f"{s} {one if s == '1' else (many or one + 's')}"


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

    def now(self, season: int) -> dict:
        if ("now", season) not in self.cache:
            self.cache[("now", season)] = ratings_now(self, season)
        return self.cache[("now", season)]

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
        k_pass, k_run = rate.rank(method="min"), ybc.rank(ascending=False, method="min")
        for team in set(pp_pass) | set(pp_run):
            a, b = pp_pass.get(team, 0.5), pp_run.get(team, 0.5)
            pas = f"pressure allowed on {rate[team]:.0%} of dropbacks ({ordinal(int(k_pass[team]))} best of {len(rate)} lines)" \
                if team in rate else "no pass-blocking data yet"
            run = f"{ybc[team]:.1f} yards before contact per carry ({ordinal(int(k_run[team]))} best)" if team in ybc else "no run data yet"
            out["ol"][team] = ((a + b) / 2, f"Graded as a unit: {pas}, {run}")

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


# ------------------------------------------------- current composite ratings ---
NOW_FILES = {"stats": ("stats_player", "stats_player_week_{s}.parquet")}
NGS_FILES = {k: ("nextgen_stats", f"ngs_{k}.parquet") for k in ("rushing", "passing")}


def _z(x: pd.Series, pool: pd.Series) -> pd.Series:
    sd = pool.std()
    return (x - pool.mean()) / (sd if sd and np.isfinite(sd) and sd > 0 else 1.0)


def ratings_now(R: "Ratings", season: int) -> dict:
    """League percentiles at each position for this season so far (last season counts PRIOR_SEASON_WEIGHT),
    from composites of the best public measures, shrunk toward the position average:

      QB     EPA per dropback (0.7) and completion % over expected, NFL Next Gen Stats (0.3)
      RB     rush yards over expected per carry, Next Gen Stats (0.4), rushing EPA per carry (0.3),
             scrimmage yards per game (0.3)
      WR/TE  weighted opportunity rating (target and air-yards share, 0.4), receiving yards per game
             (0.4), EPA per target (0.2)
      EDGE/DL pressures per snap (0.6), sacks per game (0.25), tackles for loss per game (0.15)
      LB     tackles per snap, tackles for loss per game, missed-tackle rate, passer rating allowed
      CB     passer rating allowed (0.65), passes defended and interceptions per target (0.35)
      S      passer rating allowed (0.45), missed-tackle rate (0.3), passes defended + INT per game (0.25)
      OL     the line as a unit (see Ratings): pressure rate allowed and yards before contact
    """
    T = R.T
    seasons = (season - 1, season)
    wf = lambda d: np.where(d["season"] == season, 1.0, np.where(d["season"] == season - 1, PRIOR_SEASON_WEIGHT, 0.0))
    ps = read_seasons(*NOW_FILES["stats"], seasons)
    ps = ps.assign(w=wf(ps))
    ps = ps[ps["w"] > 0]
    ngs = {k: pd.read_parquet(_get(*v)) for k, v in NGS_FILES.items()}
    for k in ngs:
        n = ngs[k]
        n = n[(n["week"] > 0) & n["season"].isin(seasons)]
        ngs[k] = n.assign(w=wf(n))
    snaps = T["snaps"][T["snaps"]["season"].isin(seasons)]
    snaps = snaps.assign(w=wf(snaps))
    pos_mode = snaps.groupby("pfr_player_id")["position"].agg(lambda x: x.mode().iat[0])
    out = {"player": {}, "ol": R.week(season, int(snaps["week"].max()) + 1)["ol"], "grp": {}}
    to_pfr = R.gsis_to_pfr

    def emit(ids_gsis, comp, pool_mask, stats, pos_label):
        pc = np.sort(comp[pool_mask].to_numpy())
        for gid, c, st in zip(ids_gsis, comp, stats):
            if not len(pc):
                continue
            p = (np.searchsorted(pc, c, "left") + np.searchsorted(pc, c, "right")) / 2 / len(pc)
            pfr = to_pfr.get(gid)
            if pfr:
                out["player"][pfr] = (float(p), st)

    # QB
    pbp = T["pbp"]
    pbp = pbp[pbp["season"].isin(seasons)].assign(w=lambda d: wf(d))
    q = pbp[(pbp["qb_dropback"] == 1) & pbp["id"].notna() & pbp["qb_epa"].notna()]
    g = q.assign(we=q["w"] * q["qb_epa"]).groupby("id").agg(n=("w", "sum"), e=("we", "sum"), raw=("w", "size"))
    pq = ps[ps["attempts"] > 0].assign(wc=lambda d: d["w"] * d["passing_cpoe"].fillna(0) * d["attempts"], wa=lambda d: d["w"] * d["attempts"])
    cp = pq.groupby("player_id").agg(c=("wc", "sum"), a=("wa", "sum"))
    g = g.join(cp, how="left").fillna({"c": 0.0, "a": 0.0})
    m_e, m_c = g["e"].sum() / g["n"].sum(), g["c"].sum() / max(g["a"].sum(), 1)
    g["epa"] = (g["e"] + 150 * m_e) / (g["n"] + 150)
    g["cpoe"] = (g["c"] + 150 * m_c) / (g["a"] + 150)
    pool = g["n"] >= 150
    g["comp"] = 0.7 * _z(g["epa"], g.loc[pool, "epa"]) + 0.3 * _z(g["cpoe"], g.loc[pool, "cpoe"])
    emit(g.index, g["comp"], pool, [f"EPA per dropback {r.e / r.n:+.2f}, completion % over expected {r.c / max(r.a, 1):+.1f} "
                                    f"({count(r.raw, 'dropback')})" for r in g.itertuples()], "QB")

    # RB
    rb = ps[ps["position"] == "RB"].assign(we=lambda d: d["w"] * d["rushing_epa"].fillna(0), wc=lambda d: d["w"] * d["carries"],
                                         wy=lambda d: d["w"] * (d["rushing_yards"].fillna(0) + d["receiving_yards"].fillna(0)),
                                         wr=lambda d: d["w"] * d["rushing_yards"].fillna(0))
    rb = rb.groupby("player_id").agg(e=("we", "sum"), c=("wc", "sum"), y=("wy", "sum"), ry=("wr", "sum"), gms=("w", "sum"),
                                     raw=("carries", "sum"))
    nr = ngs["rushing"].assign(wo=lambda d: d["w"] * d["rush_yards_over_expected"], wa=lambda d: d["w"] * d["rush_attempts"])
    nr = nr.groupby("player_gsis_id").agg(o=("wo", "sum"), a=("wa", "sum"))
    rb = rb.join(nr, how="left").fillna({"o": 0.0, "a": 0.0})
    m_e, m_o, m_y = rb["e"].sum() / rb["c"].sum(), rb["o"].sum() / max(rb["a"].sum(), 1), rb["y"].sum() / rb["gms"].sum()
    rb["epa"] = (rb["e"] + 60 * m_e) / (rb["c"] + 60)
    rb["ryoe"] = (rb["o"] + 60 * m_o) / (rb["a"] + 60)
    rb["ypg"] = (rb["y"] + 3 * m_y) / (rb["gms"] + 3)
    pool = rb["c"] >= 60
    rb["comp"] = (0.4 * _z(rb["ryoe"], rb.loc[pool, "ryoe"]) + 0.3 * _z(rb["epa"], rb.loc[pool, "epa"])
                  + 0.3 * _z(rb["ypg"], rb.loc[pool, "ypg"]))
    emit(rb.index, rb["comp"], pool, [f"{r.ry / max(r.c, 1e-9):.1f} yards per carry, {r.o / max(r.a, 1e-9):+.2f} rush yards over "
                                      f"expected per carry, {r.y / r.gms:.0f} scrimmage yards per game" for r in rb.itertuples()], "RB")

    # WR / TE
    rc = ps[ps["position"].isin(["WR", "TE"])].assign(wt=lambda d: d["w"] * d["targets"], wy=lambda d: d["w"] * d["receiving_yards"].fillna(0),
                                                     we=lambda d: d["w"] * d["receiving_epa"].fillna(0),
                                                     wo=lambda d: d["w"] * d["wopr"].fillna(0), wts=lambda d: d["w"] * d["target_share"].fillna(0))
    rc = rc.groupby(["player_id", "position"]).agg(t=("wt", "sum"), y=("wy", "sum"), e=("we", "sum"), o=("wo", "sum"),
                                                   ts=("wts", "sum"), gms=("w", "sum")).reset_index()
    for pos in ("WR", "TE"):
        s_ = rc[rc["position"] == pos].set_index("player_id")
        if not len(s_):
            continue
        s_["wopr"] = (s_["o"] + 4 * s_["o"].sum() / s_["gms"].sum()) / (s_["gms"] + 4)
        s_["ypg"] = (s_["y"] + 4 * s_["y"].sum() / s_["gms"].sum()) / (s_["gms"] + 4)
        s_["ept"] = (s_["e"] + 40 * s_["e"].sum() / s_["t"].sum()) / (s_["t"] + 40)
        pool = s_["t"] >= 30
        s_["comp"] = (0.4 * _z(s_["wopr"], s_.loc[pool, "wopr"]) + 0.4 * _z(s_["ypg"], s_.loc[pool, "ypg"])
                      + 0.2 * _z(s_["ept"], s_.loc[pool, "ept"]))
        emit(s_.index, s_["comp"], pool, [f"{r.ts / r.gms:.0%} target share, {r.y / r.gms:.0f} receiving yards per game, "
                                          f"EPA per target {r.e / max(r.t, 1e-9):+.2f}" for r in s_.itertuples()], pos)

    # defense: PFR pressures and coverage on top of snap counts, plus box-score defense
    de = T["def"][T["def"]["season"].isin(seasons)]
    dsn = snaps[snaps["defense_snaps"] > 0][["game_id", "pfr_player_id", "defense_snaps", "w"]]
    cols = ["def_pressures", "def_tackles_combined", "def_missed_tackles", "def_targets", "def_completions_allowed",
            "def_yards_allowed", "def_receiving_td_allowed", "def_ints"]
    d = dsn.merge(de[["game_id", "pfr_player_id"] + cols], on=["game_id", "pfr_player_id"], how="left")
    d[cols] = d[cols].fillna(0)
    raw = d.groupby("pfr_player_id")[["defense_snaps"] + cols].sum()
    for c in ["defense_snaps"] + cols:
        d[c] = d[c] * d["w"]
    g = d.groupby("pfr_player_id")[["defense_snaps"] + cols].sum()
    g["gms"] = d.groupby("pfr_player_id")["w"].sum()
    box = ps.assign(pfr=ps["player_id"].map(to_pfr))
    box = box.assign(ws=lambda x: x["w"] * x["def_sacks"].fillna(0), wt=lambda x: x["w"] * x["def_tackles_for_loss"].fillna(0),
                     wp=lambda x: x["w"] * x["def_pass_defended"].fillna(0), rs=lambda x: x["def_sacks"].fillna(0),
                     rp=lambda x: x["def_pass_defended"].fillna(0)).groupby("pfr").agg(
        sk=("ws", "sum"), tfl=("wt", "sum"), pd_=("wp", "sum"), rsk=("rs", "sum"), rpd=("rp", "sum"))
    g = g.join(box, how="left").fillna(0.0)
    ids = pd.Series(g.index, index=g.index)
    role = ids.map(R.role)
    pos = ids.map(pos_mode).fillna(ids.map(R.pfr_pos))
    guess = np.where(pos.isin(["DE", "OLB"]), "EDGE", np.where(pos.isin(["DT", "NT", "DL"]), "DL", np.where(pos.isin(LB_POS), "LB",
                     np.where(pos.isin(CB_POS), "CB", np.where(pos.isin(S_POS), "S", "X")))))
    g["grp"] = role.fillna(pd.Series(guess, index=g.index))
    out["grp"] = g["grp"].to_dict()
    gms = g["gms"].clip(lower=1e-9)

    def emit_pfr(sub, comp, pool, stats):
        pc = np.sort(comp[pool].to_numpy())
        for pfr, c, st in zip(sub.index, comp, stats):
            if len(pc):
                out["player"][pfr] = (float((np.searchsorted(pc, c, "left") + np.searchsorted(pc, c, "right")) / 2 / len(pc)), st)

    def shrunk(num, den, k):
        m0 = num.sum() / max(den.sum(), 1e-9)
        return (num + k * m0) / (den + k)

    def cover(sub, k):
        tg = sub["def_targets"]
        r_ = [sub[c].sum() / max(tg.sum(), 1) for c in ("def_completions_allowed", "def_yards_allowed", "def_receiving_td_allowed", "def_ints")]
        return pd.Series(passer_rating(tg + k, sub["def_completions_allowed"] + k * r_[0], sub["def_yards_allowed"] + k * r_[1],
                                       sub["def_receiving_td_allowed"] + k * r_[2], sub["def_ints"] + k * r_[3]), index=sub.index)

    for grp in ("EDGE", "DL"):
        sub = g[g["grp"] == grp]
        if not len(sub):
            continue
        pool = sub["defense_snaps"] >= MIN_SNAPS
        pr = shrunk(sub["def_pressures"], sub["defense_snaps"], K_SNAPS)
        sk = shrunk(sub["sk"], sub["gms"], 3)
        tf = shrunk(sub["tfl"], sub["gms"], 3)
        comp = 0.6 * _z(pr, pr[pool]) + 0.25 * _z(sk, sk[pool]) + 0.15 * _z(tf, tf[pool])
        rr = raw.loc[sub.index]
        emit_pfr(sub, comp, pool, [f"{count(a.def_pressures, 'pressure')} and {count(b, 'sack')} in {count(a.defense_snaps, 'snap')}"
                                   for a, b in zip(rr.itertuples(), sub["rsk"])])
    sub = g[g["grp"] == "LB"]
    if len(sub):
        pool = sub["defense_snaps"] >= MIN_SNAPS
        tk = shrunk(sub["def_tackles_combined"], sub["defense_snaps"], K_SNAPS)
        tf = shrunk(sub["tfl"], sub["gms"], 3)
        ms = shrunk(sub["def_missed_tackles"], sub["def_tackles_combined"] + sub["def_missed_tackles"], K_TACKLES)
        cv = cover(sub, K_TGT_LB)
        comp = (0.3 * _z(tk, tk[pool]) + 0.2 * _z(tf, tf[pool]) - 0.25 * _z(ms, ms[pool]) - 0.25 * _z(cv, cv[pool]))
        rr = raw.loc[sub.index]
        rc_ = passer_rating(rr["def_targets"], rr["def_completions_allowed"], rr["def_yards_allowed"], rr["def_receiving_td_allowed"], rr["def_ints"])
        emit_pfr(sub, comp, pool, [f"{count(a.def_tackles_combined, 'tackle')} in {count(a.defense_snaps, 'snap')}, missed "
                                   f"{a.def_missed_tackles / max(a.def_tackles_combined + a.def_missed_tackles, 1):.0%}, passer rating "
                                   f"allowed {c:.0f}" for a, c in zip(rr.itertuples(), rc_)])
    for grp, k in (("CB", K_TGT_CB), ("S", K_TGT_S)):
        sub = g[g["grp"] == grp]
        if not len(sub):
            continue
        cv = cover(sub, k)
        rr = raw.loc[sub.index]
        rc_ = passer_rating(rr["def_targets"], rr["def_completions_allowed"], rr["def_yards_allowed"], rr["def_receiving_td_allowed"], rr["def_ints"])
        if grp == "CB":
            pool = sub["def_targets"] >= MIN_TGT
            pdt = shrunk(sub["pd_"] + sub["def_ints"], sub["def_targets"], k)
            comp = -0.65 * _z(cv, cv[pool]) + 0.35 * _z(pdt, pdt[pool])
        else:
            pool = sub["defense_snaps"] >= MIN_SNAPS
            ms = shrunk(sub["def_missed_tackles"], sub["def_tackles_combined"] + sub["def_missed_tackles"], K_TACKLES)
            pdg = shrunk(sub["pd_"] + sub["def_ints"], sub["gms"], 3)
            comp = -0.45 * _z(cv, cv[pool]) - 0.3 * _z(ms, ms[pool]) + 0.25 * _z(pdg, pdg[pool])
        emit_pfr(sub, comp, pool, [f"Passer rating allowed {c:.0f} on {count(a.def_targets, 'target')}, "
                                   f"{count(pdv, 'pass defended', 'passes defended')}, "
                                   f"{a.def_ints:.0f} INT" for a, c, pdv in zip(rr.itertuples(), rc_, sub["rpd"])])
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
