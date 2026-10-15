"""Player ratings for the daily game: our own overall rating, 40 to 99, position by position.

Each player's rating blends two parts, each a z-score within his position group:

  performance  the best public measures of how he has played, over the last five seasons with each
               game weighted by season (the latest most); see METRICS.
  standing     how the league values him: his contract as a share of the salary cap (OverTheCap),
               Pro Bowls and first-team All-Pros (counting a little less past 34), where he was drafted,
               and how much of the time his team plays him (healthy weeks; see current.roles).

Quarterbacks lean more on honors, since a passer's numbers lean on his supporting cast.
Performance gets more weight the more he has played (weight PERF_CAP[group] * n / (n + K[group]),
n his weighted plays or snaps), so a rookie or a backup leans on his standing and a veteran on his
play. Offensive linemen have no public per-player measures: their performance part is their line's
(pressure rate allowed, yards before contact), and it gets little weight. The blend is put on a
40-99 scale where the average starter at the position is 77, one standard deviation above is 86,
and the scale bends above 88 so the very best land between 93 and 99; kickers and punters get the same scale from their kicking ratings.

check() prints the best players at each position and how the ratings line up with the 2025 All-Pro
teams, so the scale can be judged against an outside view.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.stats import norm

from . import config, live
from . import players as PL

SEASON_W = {2022: 0.05, 2023: 0.15, 2024: 0.4, 2025: 1.0, 2026: 1.0}   # per game, by season: last season and this one count most
GROUPS = ["QB", "RB", "WR", "TE", "OL", "EDGE", "DL", "LB", "CB", "S"]
OFFENSE = {"QB", "RB", "WR", "TE", "OL"}
K = {"QB": 250, "RB": 150, "WR": 60, "TE": 60, "OL": 600, "EDGE": 350, "DL": 400, "LB": 450, "CB": 70, "S": 450}
PERF_CAP = {"QB": 0.6, "RB": 0.6, "WR": 0.7, "TE": 0.55, "OL": 0.35, "EDGE": 0.7, "DL": 0.65, "LB": 0.55, "CB": 0.55, "S": 0.55}
STANDING = {"contract": 0.45, "honors": 0.25, "draft": 0.1, "usage": 0.2}
STANDING_OL = {"contract": 0.4, "honors": 0.25, "draft": 0.1, "usage": 0.25}
STANDING_QB = {"contract": 0.35, "honors": 0.4, "draft": 0.05, "usage": 0.2}   # a QB's numbers lean on his supporting cast
CENTER, SPREAD = 77.0, 9.5            # OVR of the average starter, and per standard deviation among starters
TOP, ROOM = 88.0, 12.0                # above TOP the scale bends toward 100 so the best players stay apart
STARTER_ROLE = 0.5                    # a starter plays at least this share of his side's snaps
POS_GROUP = {"QB": "QB", "RB": "RB", "HB": "RB", "FB": "RB", "WR": "WR", "TE": "TE", "T": "OL", "G": "OL", "C": "OL", "OL": "OL",
             "OT": "OL", "OG": "OL", "DE": "EDGE", "OLB": "EDGE", "DT": "DL", "NT": "DL", "DL": "DL", "LB": "LB", "ILB": "LB",
             "MLB": "LB", "CB": "CB", "DB": "CB", "S": "S", "FS": "S", "SS": "S", "SAF": "S"}
PFF = {"ED": "EDGE", "DI": "DL", "LB": "LB", "CB": "CB", "S": "S"}
OTC_GROUP = {"QB": "QB", "RB": "RB", "FB": "RB", "WR": "WR", "TE": "TE", "LT": "OL", "RT": "OL", "LG": "OL", "RG": "OL", "C": "OL",
             "IOL": "OL", "OT": "OL", "ED": "EDGE", "EDGE": "EDGE", "IDL": "DL", "DT": "DL", "LB": "LB", "ILB": "LB", "CB": "CB",
             "S": "S", "SAF": "S"}


def _weights(df: pd.DataFrame, col: str = "season", sw: dict | None = None) -> np.ndarray:
    return df[col].map(sw or SEASON_W).fillna(0.0).to_numpy()


def _shrunk(num: pd.Series, den: pd.Series, k: float) -> pd.Series:
    """num/den pulled toward the pool's rate by k pseudo-observations."""
    m0 = num.sum() / max(den.sum(), 1e-9)
    return (num + k * m0) / (den + k)


def _z(x: pd.Series, ref: pd.Series) -> pd.Series:
    sd = ref.std()
    return ((x - ref.mean()) / (sd if sd and np.isfinite(sd) and sd > 0 else 1.0)).clip(-3.5, 3.5)


def _load(seasons=None):
    seasons = sorted(seasons or SEASON_W)
    T = PL.load_tables(seasons)
    st = PL.read_seasons("stats_player", "stats_player_week_{s}.parquet", seasons)
    st = st[st["season_type"] == "REG"]
    ngs = {k: pd.read_parquet(PL._get("nextgen_stats", f"ngs_{k}.parquet")) for k in ("rushing", "receiving")}
    ngs = {k: v[(v["week"] > 0) & v["season"].isin(seasons)] for k, v in ngs.items()}
    cols = ["season", "season_type", "game_id", "posteam", "id", "qb_dropback", "qb_epa", "play_type", "rusher_player_id",
            "qb_scramble", "epa", "two_point_attempt", "week"]
    pbp = pd.concat([pd.read_parquet(PL.pbp_path(s), columns=cols) for s in PL.pbp_seasons(seasons)], ignore_index=True)
    pbp = pbp[(pbp["season_type"] == "REG") & (pbp["two_point_attempt"].fillna(0) == 0)]
    T["rec"] = PL.read_seasons("pfr_advstats", "advstats_week_rec_{s}.parquet", seasons)
    return T, st, ngs, pbp


def groups(T: dict) -> pd.Series:
    """Each player's position group (by gsis id): PFF's role on defense where known, else his latest snaps."""
    pl = T["players"].dropna(subset=["pfr_id"])
    to_gsis = dict(zip(pl["pfr_id"], pl["gsis_id"]))
    sn = T["snaps"].sort_values(["season", "week"])
    last = sn.drop_duplicates("pfr_player_id", keep="last").set_index("pfr_player_id")["position"].map(POS_GROUP)
    g = pd.Series(last.to_numpy(), index=last.index.map(to_gsis))
    g = g[g.index.notna()]
    pff = pd.Series({gid: PFF[v] for gid, v in zip(T["players"]["gsis_id"], T["players"]["pff_position"]) if v in PFF})
    defense = g.isin(["EDGE", "DL", "LB", "CB", "S"])
    g.loc[defense] = pff.reindex(g.index[defense]).fillna(g[defense]).to_numpy()
    g = g[~g.index.duplicated()]
    # before snap counts (2012): the players table's position
    rest = T["players"].dropna(subset=["gsis_id"]).drop_duplicates("gsis_id")
    rest = pd.Series(rest["position"].map(POS_GROUP).to_numpy(), index=rest["gsis_id"]).dropna()
    rest = rest[~rest.index.isin(g.index)]
    return pd.concat([g, rest])


def performance(T: dict, st: pd.DataFrame, ngs: dict, pbp: pd.DataFrame, grp: pd.Series, sw: dict | None = None) -> pd.DataFrame:
    """perf (z within group), n (weighted plays or snaps) and a few raw measures, by gsis id; sw: per-game
    weight by season (SEASON_W unless given)."""
    wts = lambda d: _weights(d, sw=sw)  # noqa: E731
    pl = T["players"].dropna(subset=["pfr_id"])
    to_gsis = dict(zip(pl["pfr_id"], pl["gsis_id"]))
    out = []

    def finish(df: pd.DataFrame, group: str, parts: dict, n: pd.Series, n_min: float):
        ref = n >= n_min
        z = sum(w * _z(df[c], df.loc[ref, c]) * sign for c, (w, sign) in parts.items())
        out.append(pd.DataFrame({"perf": _z(z, z[ref]), "n": n, "pgroup": group}, index=df.index))

    # quarterbacks: EPA per play (dropbacks and designed runs) and completion % over expected
    pbp = pbp.assign(w=wts(pbp))
    drop = pbp[(pbp["qb_dropback"] == 1) & pbp["id"].notna() & pbp["qb_epa"].notna()]
    qbs = grp[grp == "QB"].index
    runs = pbp[(pbp["play_type"] == "run") & (pbp["qb_scramble"].fillna(0) == 0) & pbp["rusher_player_id"].isin(qbs) & pbp["epa"].notna()]
    q = pd.DataFrame({"e": (drop["qb_epa"] * drop["w"]).groupby(drop["id"]).sum(), "n": drop.groupby("id")["w"].sum()})
    q = q[q.index.isin(qbs)]
    r = pd.DataFrame({"e": (runs["epa"] * runs["w"]).groupby(runs["rusher_player_id"]).sum(), "n": runs.groupby("rusher_player_id")["w"].sum()})
    q = q.add(r.reindex(q.index).fillna(0.0), fill_value=0.0)
    sq = st[st["attempts"] > 0].assign(w=lambda d: wts(d))
    cp = (sq["passing_cpoe"].fillna(0) * sq["attempts"] * sq["w"]).groupby(sq["player_id"]).sum()
    ca = (sq["attempts"] * sq["w"]).groupby(sq["player_id"]).sum()
    q["value"] = _shrunk(q["e"], q["n"], 150)
    q["cpoe"] = _shrunk(cp.reindex(q.index).fillna(0.0), ca.reindex(q.index).fillna(0.0), 150)
    finish(q, "QB", {"value": (0.7, 1), "cpoe": (0.3, 1)}, q["n"], 300)

    # running backs: rush yards over expected, rushing EPA, scrimmage yards per game, receiving EPA
    sr = st[st["position"].isin(["RB", "FB"])].assign(w=lambda d: wts(d))
    agg = lambda c: (sr[c].fillna(0) * sr["w"]).groupby(sr["player_id"]).sum()
    rb = pd.DataFrame({"car": agg("carries"), "ry": agg("rushing_yards"), "re": agg("rushing_epa"), "tg": agg("targets"),
                       "rcy": agg("receiving_yards"), "rce": agg("receiving_epa"), "g": sr.groupby("player_id")["w"].sum()})
    nr = ngs["rushing"].assign(w=lambda d: wts(d))
    rb["oe"] = (nr["rush_yards_over_expected"].fillna(0) * nr["w"]).groupby(nr["player_gsis_id"]).sum().reindex(rb.index).fillna(0.0)
    rb["oa"] = (nr["rush_attempts"].fillna(0) * nr["w"]).groupby(nr["player_gsis_id"]).sum().reindex(rb.index).fillna(0.0)
    rb["ryoe"] = _shrunk(rb["oe"], rb["oa"], 80)
    rb["epa"] = _shrunk(rb["re"], rb["car"], 80)
    rb["ypg"] = _shrunk(rb["ry"] + rb["rcy"], rb["g"], 3)
    rb["rec"] = _shrunk(rb["rce"], rb["tg"], 30)
    finish(rb, "RB", {"ryoe": (0.3, 1), "epa": (0.2, 1), "ypg": (0.35, 1), "rec": (0.15, 1)}, rb["car"] + rb["tg"], 120)

    # receivers and tight ends: yards per game, target and air-yards share, EPA per target, YAC over expected
    nrc = ngs["receiving"].assign(w=lambda d: wts(d))
    yoe = (nrc["avg_yac_above_expectation"].fillna(0) * nrc["receptions"].fillna(0) * nrc["w"]).groupby(nrc["player_gsis_id"]).sum()
    yrc = (nrc["receptions"].fillna(0) * nrc["w"]).groupby(nrc["player_gsis_id"]).sum()
    for pos in ("WR", "TE"):
        s_ = st[st["position"] == pos].assign(w=lambda d: wts(d))
        agg = lambda c: (s_[c].fillna(0) * s_["w"]).groupby(s_["player_id"]).sum()
        d = pd.DataFrame({"tg": agg("targets"), "y": agg("receiving_yards"), "e": agg("receiving_epa"), "o": agg("wopr"),
                          "g": s_.groupby("player_id")["w"].sum()})
        d["ypg"] = _shrunk(d["y"], d["g"], 4)
        d["wopr"] = _shrunk(d["o"], d["g"], 4)
        d["ept"] = _shrunk(d["e"], d["tg"], 40)
        d["yacoe"] = _shrunk(yoe.reindex(d.index).fillna(0.0), yrc.reindex(d.index).fillna(0.0), 30)
        finish(d, pos, {"ypg": (0.35, 1), "wopr": (0.25, 1), "ept": (0.25, 1), "yacoe": (0.15, 1)}, d["tg"], 50)

    # defense: PFR charting (pressures, tackling, coverage) on snap counts, box-score sacks, TFL, hits, PDs
    sn = T["snaps"].assign(w=lambda d: wts(d))
    dsn = sn[sn["defense_snaps"] > 0][["game_id", "pfr_player_id", "defense_snaps", "w"]]
    cols = ["def_pressures", "def_tackles_combined", "def_missed_tackles", "def_targets", "def_completions_allowed",
            "def_yards_allowed", "def_receiving_td_allowed", "def_ints"]
    d = dsn.merge(T["def"][["game_id", "pfr_player_id"] + cols], on=["game_id", "pfr_player_id"], how="left").fillna({c: 0 for c in cols})
    for c in ["defense_snaps"] + cols:
        d[c] = d[c] * d["w"]
    dd = d.groupby("pfr_player_id")[["defense_snaps"] + cols].sum()
    dd["g"] = d.groupby("pfr_player_id")["w"].sum()
    dd.index = dd.index.map(to_gsis)
    dd = dd[dd.index.notna()].groupby(level=0).sum()
    box = st.assign(w=lambda x: wts(x))
    box = box[box[["def_sacks", "def_tackles_for_loss", "def_qb_hits", "def_pass_defended"]].fillna(0).sum(axis=1) > 0]
    bagg = lambda c: (box[c].fillna(0) * box["w"]).groupby(box["player_id"]).sum()
    # a defender the box score knows but snap counts do not (before 2012): his games stand in for his snaps
    bg = box.groupby("player_id")["w"].sum()
    dd = dd.reindex(dd.index.union(bg.index)).fillna(0.0)
    dd["g"] = np.maximum(dd["g"], bg.reindex(dd.index).fillna(0.0))
    dd["defense_snaps"] = dd["defense_snaps"].where(dd["defense_snaps"] > 0, dd["g"] * 60)
    for c, src in (("sk", "def_sacks"), ("tfl", "def_tackles_for_loss"), ("hits", "def_qb_hits"), ("pd", "def_pass_defended")):
        dd[c] = bagg(src).reindex(dd.index).fillna(0.0)
    snaps, games, tg = dd["defense_snaps"], dd["g"], dd["def_targets"]
    rate = lambda c, den, k: _shrunk(dd[c], den, k)
    cov = pd.Series(PL.passer_rating(tg + 30, dd["def_completions_allowed"] + 30 * dd["def_completions_allowed"].sum() / max(tg.sum(), 1),
                                     dd["def_yards_allowed"] + 30 * dd["def_yards_allowed"].sum() / max(tg.sum(), 1),
                                     dd["def_receiving_td_allowed"] + 30 * dd["def_receiving_td_allowed"].sum() / max(tg.sum(), 1),
                                     dd["def_ints"] + 30 * dd["def_ints"].sum() / max(tg.sum(), 1)), index=dd.index)
    m = pd.DataFrame({
        "pr": rate("def_pressures", snaps, 300), "sk": rate("sk", games, 4), "tfl": rate("tfl", games, 4), "hits": rate("hits", games, 4),
        "tk": rate("def_tackles_combined", snaps, 300), "mtr": _shrunk(dd["def_missed_tackles"], dd["def_tackles_combined"] + dd["def_missed_tackles"], 25),
        "cov": cov, "ypt": _shrunk(dd["def_yards_allowed"], tg, 40), "ball": _shrunk(dd["def_ints"] + dd["pd"], tg, 40),
        "pdg": _shrunk(dd["def_ints"] + dd["pd"], games, 4)}, index=dd.index)
    for g_, parts, nvar, nmin in (
            ("EDGE", {"pr": (0.5, 1), "sk": (0.25, 1), "tfl": (0.15, 1), "hits": (0.1, 1)}, snaps, 400),
            ("DL", {"pr": (0.45, 1), "sk": (0.2, 1), "tfl": (0.25, 1), "hits": (0.1, 1)}, snaps, 400),
            ("LB", {"tk": (0.25, 1), "tfl": (0.2, 1), "mtr": (0.2, -1), "cov": (0.15, -1), "pr": (0.1, 1), "pdg": (0.1, 1)}, snaps, 400),
            ("CB", {"cov": (0.35, -1), "ball": (0.35, 1), "ypt": (0.15, -1), "mtr": (0.15, -1)}, tg, 60),
            ("S", {"cov": (0.3, -1), "pdg": (0.25, 1), "mtr": (0.25, -1), "tk": (0.1, 1), "tfl": (0.1, 1)}, snaps, 400)):
        ids = grp[grp == g_].index.intersection(m.index)
        finish(m.loc[ids], g_, parts, nvar.loc[ids], nmin)

    # offensive linemen: their line's pressure rate allowed and yards before contact, by team-season
    pa = T["pass"].assign(w=lambda d: wts(d))
    pr_ = pa.groupby(["season", "team"])["times_pressured"].sum()
    db = pbp[pbp["qb_dropback"] == 1].groupby(["season", "posteam"]).size()
    db.index.names = ["season", "team"]
    ru = T["rush"]
    ybc = ru.groupby(["season", "team"])["rushing_yards_before_contact"].sum() / ru.groupby(["season", "team"])["carries"].sum()
    unit = pd.DataFrame({"pres": pr_ / db.reindex(pr_.index), "ybc": ybc}).dropna()
    unit["z"] = unit.groupby(level=0)["pres"].transform(lambda x: -(x - x.mean()) / x.std()) * 0.6 + \
        unit.groupby(level=0)["ybc"].transform(lambda x: (x - x.mean()) / x.std()) * 0.4
    ol = sn[(sn["offense_snaps"] > 0) & sn["position"].isin(["T", "G", "C", "OL", "OT", "OG"])]
    ol = ol.assign(z=[unit["z"].get((s, t), 0.0) for s, t in zip(ol["season"], ol["team"])], ws=ol["offense_snaps"] * ol["w"])
    o = pd.DataFrame({"unit": (ol["z"] * ol["ws"]).groupby(ol["pfr_player_id"]).sum() / ol.groupby("pfr_player_id")["ws"].sum(),
                      "n": ol.groupby("pfr_player_id")["ws"].sum()})
    o.index = o.index.map(to_gsis)
    o = o[o.index.notna() & o.index.isin(grp[grp == "OL"].index)].groupby(level=0).mean()
    finish(o, "OL", {"unit": (1.0, 1)}, o["n"], 600)
    perf = pd.concat(out)
    return perf[~perf.index.duplicated(keep="first")]


def _share(grp: pd.Series, role: pd.DataFrame) -> np.ndarray:
    """His usual share of his side's snaps: this season's healthy weeks, else last season's (0 if neither)."""
    r = role.reindex(grp.index)
    return np.nan_to_num(np.where(grp.isin(OFFENSE), r["o"].fillna(r["po"]), r["d"].fillna(r["pd"])).astype(float))


def standing(T: dict, grp: pd.Series, role: pd.DataFrame | None, season: int) -> pd.DataFrame:
    """contract, honors, draft and usage z-scores within each position group, by gsis id."""
    pl = T["players"]
    con = pd.read_parquet(PL._get("contracts", "historical_contracts.parquet"))
    con = con[con["gsis_id"].notna()].sort_values(["is_active", "year_signed", "apy"]).drop_duplicates("gsis_id", keep="last")
    con = con.set_index("gsis_id")
    dp = pd.read_parquet(PL._get("draft_picks", "draft_picks.parquet"))
    dp = dp[dp["gsis_id"].notna()].drop_duplicates("gsis_id", keep="last").set_index("gsis_id")
    full = pd.read_parquet(PL._get("players", "players.parquet"), columns=["gsis_id", "birth_date", "draft_pick"]).drop_duplicates("gsis_id").set_index("gsis_id")
    ids = grp.index
    age = (pd.Timestamp(f"{season}-10-01") - pd.to_datetime(full["birth_date"].reindex(ids), errors="coerce")).dt.days / 365.25
    honors = np.log1p(dp["probowls"].reindex(ids).fillna(0)) + 0.8 * np.log1p(dp["allpro"].reindex(ids).fillna(0))
    honors = honors * np.clip(1 - 0.04 * np.maximum(age.fillna(27) - 34, 0), 0.5, 1.0)     # old honors fade a little
    pick = full["draft_pick"].reindex(ids).fillna(300).clip(1, 300)
    s = pd.DataFrame({"grp": grp, "apy": con["apy_cap_pct"].reindex(ids), "honors": honors, "draft": -np.log(pick), "age": age}, index=ids)
    if role is not None:
        s["usage"] = _share(s["grp"], role)
    out = pd.DataFrame(index=ids)
    for g_ in GROUPS:
        m = s["grp"] == g_
        sub = s[m]
        if not len(sub):
            continue
        ap = sub["apy"]
        out.loc[m, "contract"] = norm.ppf(((ap.rank(pct=True) - 0.5 / ap.notna().sum()).clip(0.005, 0.995)).to_numpy()) if ap.notna().any() else np.nan
        out.loc[m, "contract"] = np.where(ap.isna(), np.nan, out.loc[m, "contract"])
        out.loc[m, "honors"] = _z(sub["honors"], sub["honors"]).to_numpy()
        out.loc[m, "draft"] = _z(sub["draft"], sub["draft"]).to_numpy()
        if "usage" in sub:
            out.loc[m, "usage"] = _z(sub["usage"], sub["usage"]).to_numpy()
    out["age"] = s["age"]
    return out


def ratings(season: int = 2026, role: pd.DataFrame | None = None, data=None) -> pd.DataFrame:
    """Every player with a position group: perf, n, standing, score and ovr (40-99), by gsis id."""
    T, st, ngs, pbp = data or _load()
    grp = groups(T)
    perf = performance(T, st, ngs, pbp, grp)
    stand = standing(T, grp, role, season)
    df = pd.DataFrame({"grp": grp}).join(perf[["perf", "n"]], how="left").join(stand, how="left")
    df["n"] = df["n"].fillna(0.0)
    w_s = lambda g_: STANDING_OL if g_ == "OL" else STANDING_QB if g_ == "QB" else STANDING
    parts = ["contract", "honors", "draft", "usage"]
    num = np.zeros(len(df)); den = np.zeros(len(df))
    for c in parts:
        if c not in df:
            continue
        w = df["grp"].map(lambda g_: w_s(g_)[c]).to_numpy()
        v = df[c].to_numpy(float)
        ok = np.isfinite(v)
        num += np.where(ok, w * v, 0.0); den += np.where(ok, w, 0.0)
    df["standing"] = np.where(den > 0, num / np.maximum(den, 1e-9), 0.0)
    k = df["grp"].map(K).to_numpy(float)
    cap = df["grp"].map(PERF_CAP).to_numpy(float)
    wp = np.where(df["perf"].notna(), cap * df["n"] / (df["n"] + k), 0.0)
    df["w_perf"] = wp
    df["score"] = wp * df["perf"].fillna(0.0) + (1 - wp) * df["standing"]
    if role is not None:
        df["starter"] = _share(df["grp"], role) >= STARTER_ROLE
    else:
        df["starter"] = df["n"] > df["grp"].map(K)
    df["ovr"] = np.nan
    for g_ in GROUPS:
        m = df["grp"] == g_
        ref = df.loc[m & df["starter"], "score"]
        if len(ref) < 5:
            ref = df.loc[m, "score"]
        z = (df.loc[m, "score"] - ref.mean()) / (ref.std() or 1.0)
        df.loc[m, "ovr"] = scale(CENTER + SPREAD * z)
    return df


# ------------------------------------------------ as of a past week (daily-game spots) ---
LAG_W = {0: 1.0, 1: 1.0, 2: 0.4, 3: 0.15, 4: 0.05}     # per game, by seasons before the game's: as SEASON_W counts them now
STANDING_ASOF = {"contract": 0.5, "draft": 0.15, "usage": 0.35}   # no honors: the public lists give career totals only
DRAFT_FADE = 0.25                                     # where he was drafted counts this much less each season after
ASOF_FIRST = 2019                                     # earliest season loaded (the 2023 spots look back four seasons)


def load_asof(first: int = ASOF_FIRST):
    """Everything ratings_asof needs, every season it can look back to (from `first`: a spot four seasons after it
    looks back that far)."""
    return _load(range(max(PL.FIRST_SEASON, min(first, ASOF_FIRST)), max(SEASON_W) + 1))


def _before(df: pd.DataFrame, season: int, week: int) -> pd.DataFrame:
    return df[(df["season"] < season) | ((df["season"] == season) & (df["week"] < week))]


def _role_asof(T: dict, season: int, week: int) -> pd.DataFrame:
    """His share of his side's snaps in the games he played this season before the week (o, d), and last
    season's times current.PRIOR_ROLE (po, pd), by gsis id."""
    pl = T["players"].dropna(subset=["pfr_id"])
    to_gsis = dict(zip(pl["pfr_id"], pl["gsis_id"]))
    sn = T["snaps"].assign(gsis=lambda d: d["pfr_player_id"].map(to_gsis)).dropna(subset=["gsis"])
    cur = sn[(sn["season"] == season) & (sn["week"] < week)].groupby("gsis")[["offense_pct", "defense_pct"]].mean()
    prev = sn[sn["season"] == season - 1].groupby("gsis")[["offense_pct", "defense_pct"]].mean() * 0.9
    return cur.set_axis(["o", "d"], axis=1).join(prev.set_axis(["po", "pd"], axis=1), how="outer")


def standing_asof(T: dict, grp: pd.Series, role: pd.DataFrame, season: int) -> pd.DataFrame:
    """contract, draft and usage z-scores within each position group as of a past season, by gsis id. The
    contract is the latest one signed by that season and still running; a rookie deal says only where he was
    drafted, so it counts as an average contract (0), as does none at all for a player who has been playing."""
    ids = grp.index
    con = pd.read_parquet(PL._get("contracts", "historical_contracts.parquet"))
    con = con[con["gsis_id"].notna() & (con["year_signed"] <= season) & (con["year_signed"] + con["years"].fillna(1) > season)]
    con = con.sort_values(["year_signed", "apy"]).drop_duplicates("gsis_id", keep="last").set_index("gsis_id")
    rookie = con["year_signed"] == con["draft_year"]
    apy = con["apy_cap_pct"].where(~rookie)
    full = pd.read_parquet(PL._get("players", "players.parquet"), columns=["gsis_id", "draft_pick", "draft_year"]).drop_duplicates("gsis_id").set_index("gsis_id")
    pick = full["draft_pick"].reindex(ids).fillna(300).clip(1, 300)
    yrs = (season - full["draft_year"].reindex(ids)).fillna(4).clip(lower=0)
    fade = np.clip(1 - DRAFT_FADE * yrs, 0.0, 1.0).to_numpy()
    s = pd.DataFrame({"grp": grp, "apy": apy.reindex(ids), "draft": -np.log(pick), "usage": _share(grp, role)}, index=ids)
    out = pd.DataFrame(index=ids)
    for g_ in GROUPS:
        m = s["grp"] == g_
        sub = s[m]
        if not len(sub):
            continue
        ap = sub["apy"]
        if ap.notna().any():
            q = norm.ppf((ap.rank(pct=True) - 0.5 / ap.notna().sum()).clip(0.005, 0.995).to_numpy())
            out.loc[m, "contract"] = np.where(ap.isna(), 0.0, q)
        out.loc[m, "draft"] = _z(sub["draft"], sub["draft"]).to_numpy() * fade[m.to_numpy()]
        out.loc[m, "usage"] = _z(sub["usage"], sub["usage"]).to_numpy()
    return out


def ratings_asof(season: int, week: int, data=None) -> pd.DataFrame:
    """ratings() as of a past week: only games before it (the daily game's rule) and the contracts signed by
    then; perf, n, standing, score, ovr (40-99) and pct (his place among the position's starters), by gsis id."""
    T0, st0, ngs0, pbp0 = data or load_asof()
    T = {k: (_before(v, season, week) if isinstance(v, pd.DataFrame) and {"season", "week"} <= set(v.columns) else v)
         for k, v in T0.items()}
    st, pbp = _before(st0, season, week), _before(pbp0, season, week)
    ngs = {k: _before(v, season, week) for k, v in ngs0.items()}
    sw = {season - lag: w for lag, w in LAG_W.items()}
    grp = groups(T)
    perf = performance(T, st, ngs, pbp, grp, sw=sw)
    role = _role_asof(T, season, week)
    stand = standing_asof(T, grp, role, season)
    df = pd.DataFrame({"grp": grp}).join(perf[["perf", "n"]], how="left").join(stand, how="left")
    df["n"] = df["n"].fillna(0.0)
    num, den = np.zeros(len(df)), np.zeros(len(df))
    for c, w in STANDING_ASOF.items():
        v = df[c].to_numpy(float) if c in df else np.full(len(df), np.nan)
        ok = np.isfinite(v)
        num += np.where(ok, w * v, 0.0); den += np.where(ok, w, 0.0)
    df["standing"] = np.where(den > 0, num / np.maximum(den, 1e-9), 0.0)
    k, cap = df["grp"].map(K).to_numpy(float), df["grp"].map(PERF_CAP).to_numpy(float)
    df["w_perf"] = np.where(df["perf"].notna(), cap * df["n"] / (df["n"] + k), 0.0)
    df["score"] = df["w_perf"] * df["perf"].fillna(0.0) + (1 - df["w_perf"]) * df["standing"]
    df["starter"] = _share(df["grp"], role) >= STARTER_ROLE
    df["ovr"], df["pct"] = np.nan, np.nan
    for g_ in GROUPS:
        m = df["grp"] == g_
        ref = df.loc[m & df["starter"], "score"]
        if len(ref) < 5:
            ref = df.loc[m, "score"]
        z = (df.loc[m, "score"] - ref.mean()) / (ref.std() or 1.0)
        df.loc[m, "ovr"] = scale(CENTER + SPREAD * z)
        srt = np.sort(ref.to_numpy())
        sc = df.loc[m, "score"].to_numpy()
        df.loc[m, "pct"] = (np.searchsorted(srt, sc, "left") + np.searchsorted(srt, sc, "right")) / 2 / max(len(srt), 1)
    return df


def scale(x):
    """Raw points to the 40-99 scale, bending above TOP so it never runs past 99."""
    x = np.asarray(x, float)
    bent = np.where(x > TOP, TOP + ROOM * (1 - np.exp(-(x - TOP) / ROOM)), x)
    return np.clip(np.round(bent), 40, 99)


def specialist_ovr(pct: float) -> int:
    """Kickers and punters: their kicking rating's place in the league on the same 40-99 scale."""
    return int(scale(CENTER + SPREAD * norm.ppf(np.clip(pct, 0.01, 0.99))))


ALL_PRO_2025 = {   # AP first team for the 2025 season (January 2026); the fullback is left out
    "QB": ["Matthew Stafford"], "RB": ["Bijan Robinson", "Christian McCaffrey"],
    "WR": ["Puka Nacua", "Jaxon Smith-Njigba", "Ja'Marr Chase"], "TE": ["Trey McBride"],
    "OL": ["Garett Bolles", "Joe Thuney", "Creed Humphrey", "Quinn Meinerz", "Penei Sewell"],
    "EDGE": ["Myles Garrett", "Will Anderson Jr.", "Micah Parsons"], "DL": ["Jeffery Simmons", "Zach Allen"],
    "LB": ["Jack Campbell", "Jordyn Brooks"], "CB": ["Derek Stingley Jr.", "Quinyon Mitchell", "Cooper DeJean"],
    "S": ["Kyle Hamilton", "Kevin Byard"]}


def check(season: int = 2026, top: int = 10, data=None) -> pd.DataFrame:
    """Print the best players on a roster now at each position, then where the 2025 All-Pros rate."""
    from . import current as C
    S = live.load_sources(season)
    R = PL.Ratings(PL.load_tables((season - 1, season)))
    data = data or _load()
    df = ratings(season, C.roles(S, R, season), data)
    _, ok_rows, _ = C._available(S)
    df["name"] = data[0]["players"].drop_duplicates("gsis_id").set_index("gsis_id")["display_name"].reindex(df.index)
    df = df[df.index.isin(set(ok_rows["gsis_id"]))]
    for g_ in GROUPS:
        s = df[df["grp"] == g_].sort_values("ovr", ascending=False)
        st_ = s[s["starter"]]
        print(f"{g_:4s} {len(st_)} starters, median {st_['ovr'].median():.0f}: " +
              ", ".join(f"{r.name} {r.ovr:.0f}" for r in s.head(top).itertuples()))
    rows = []
    for g_, names in ALL_PRO_2025.items():
        for n in names:
            m = df[df["name"] == n].assign(here=lambda d: d["grp"] == g_).sort_values(["here", "ovr"], ascending=False)
            if len(m):                       # rated in his own group (DeJean, the slot corner, plays safety now)
                r = m.iloc[0]
                st_ = df[(df["grp"] == r["grp"]) & df["starter"]]
                rows.append({"pos": r["grp"], "name": n, "ovr": int(r["ovr"]), "rank": int((st_["ovr"] > r["ovr"]).sum()) + 1})
    ap = pd.DataFrame(rows)
    print(ap.to_string(index=False))
    print(f"2025 All-Pros: {len(ap)} rated, {(ap['ovr'] >= 90).sum()} at 90 or better, median rank at their position "
          f"{ap['rank'].median():.0f}")
    return ap
