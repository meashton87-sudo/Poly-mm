"""Every NFL team as it stands now, for the daily game.

Rosters come from nflverse's weekly rosters (the NFL's own transactions, so trades, releases and
reserve lists are current), each team's latest week. Injuries are ignored: every team plays its
healthy lineup. A player counts when he is on the active or inactive roster, or on injured reserve,
PUP or the non-football injury list; not when he is on the practice squad, cut, retired, suspended or
on the commissioner's exempt list. The 22 who play are the players with the biggest usual role (share
of the team's snaps in the weeks he was healthy, the latest counting most; see `roles`), in the
personnel the team has used most lately, with PFF's position roles (edge vs. interior) where nflverse
carries them. The quarterback, kicker and punter are picked the same way. ESPN's depth chart breaks
close calls.

Each team also gets its current ratings (as-of the latest week, with the starting QB's adjustment),
its kicker and punter, its head coach, and a power rating fitted to this season's point spreads, so
any two teams can be matched with a realistic spread.
"""
from __future__ import annotations

from itertools import permutations

import numpy as np
import pandas as pd

from . import coaches as CO
from . import archetypes as AR
from . import config, live
from . import overall as O
from . import players as PL

RECENCY = 0.5            # each earlier game counts this much of the next one
RECENT_GAMES = 5
PRIOR_SEASON_SPREADS = 0.35   # last season's spreads weigh this much when fitting power ratings
HFA = 1.5                # home-field points in the spread fit when it cannot be estimated


ROSTER_OK = {"ACT", "INA"}
HURT_LISTS = {"R01", "R04", "R05", "R40", "R48"}   # injured reserve, PUP, non-football injury or illness, IR to return
ROLE_RECENCY = 0.75      # a player's role: each earlier week counts this much of the next one
PRIOR_ROLE = 0.9         # a player with no healthy snaps this season keeps this much of last season's role
PLAYED_HURT = 0.8        # a game on the injury report below this share of his usual role was played hurt
LEFT_HURT = 0.6          # the latest game below this share of his usual role: he probably left it hurt
QUALITY = 0.25           # better players start: score weight on (overall rating - 77) / 40 ...
QUALITY_OUT = 0.5        # ... plus this on how far above 77 a player who is out is (his injury cut his role short)
DC_FROM = "08-01"        # a hurt player keeps his best depth-chart rank since this date (month-day) ...
HURT_RANK = 0.8          # ... counted at this share of a current listing (fill-in starts should not beat starters)


def _on_team(rows: pd.DataFrame) -> pd.Series:
    """Roster rows that count, injuries ignored."""
    return rows["status"].isin(ROSTER_OK) | ((rows["status"] == "RES") & rows["status_description_abbr"].isin(HURT_LISTS))


def _available(S: dict) -> tuple[dict, pd.DataFrame, set]:
    """gsis ids each team has (injuries ignored), the roster rows behind them, and who is out now: on a
    reserve list, ruled out or doubtful, or inactive for the latest game (a starter is rarely a healthy
    scratch, and the injury report can miss him: PHI's Lane Johnson in October 2026)."""
    ros, inj = S["rosters"], S["injuries"]
    wk = ros.groupby("team")["week"].transform("max")
    last = ros[(ros["week"] == wk)]
    ok = last[_on_team(last)]
    iwk = inj.groupby("team")["week"].transform("max")
    rep = inj[(inj["week"] == iwk) & inj["report_status"].isin(["Out", "Doubtful"])]
    hurt = set(ok.loc[ok["status"].isin(["RES", "INA"]), "gsis_id"]) | set(rep["gsis_id"])
    return {t: set(g["gsis_id"]) for t, g in ok.groupby("team")}, ok, hurt


def _fix_ids(dc: pd.DataFrame, rows: pd.DataFrame) -> pd.DataFrame:
    """ESPN's id crosswalk now and then points a listing at a namesake (DET's starting right tackle Blake
    Miller at a Blake Miller from the 2000s): a listed player who is not on his team's roster is matched
    by full name on it instead, when exactly one player there has that name."""
    one = rows.drop_duplicates(["team", "gsis_id"]).groupby(["team", "full_name"])["gsis_id"].agg(lambda g: g.iloc[0] if len(g) == 1 else None)
    on = set(zip(rows["team"], rows["gsis_id"]))
    swap = pd.Series([None if (t, g) in on else one.get((t, n)) for t, g, n in zip(dc["team"], dc["gsis_id"], dc["player_name"])],
                     index=dc.index, dtype=object)
    return dc.assign(gsis_id=swap.fillna(dc["gsis_id"]))


def roles(S: dict, R: PL.Ratings, season: int) -> pd.DataFrame:
    """Each player's usual share of his team's offense, defense and special-teams snaps, injuries ignored:
    o, d, st this season and po, pd, pst last season (times PRIOR_ROLE).

    This season's role is the average of his weekly shares (each earlier week counting ROLE_RECENCY of the
    next) over the weeks he was healthy: a week he was hurt (on a reserve list, or ruled out or doubtful)
    does not count, a week he was healthy and did not play counts as zero, and games he played hurt do
    not count either: a below-par game right before a week he was out, one while on the injury report,
    or a sharp drop in the latest game (he left it hurt; the next report is not out yet)."""
    sn = R.T["snaps"]
    pfr_to_gsis = {v: k for k, v in R.gsis_to_pfr.items()}
    sides = ["offense_pct", "defense_pct", "st_pct"]
    cur = sn[sn["season"] == season].assign(gsis=lambda d: d["pfr_player_id"].map(pfr_to_gsis)).dropna(subset=["gsis"])
    games = set(zip(cur["team"], cur["week"]))
    ros, inj = S["rosters"], S["injuries"]
    rep = inj[inj["report_status"].isin(["Out", "Doubtful"])]
    res = ros[(ros["status"] == "RES") & ros["status_description_abbr"].isin(HURT_LISTS)]
    hurt = set(zip(rep["gsis_id"], rep["week"])) | set(zip(res["gsis_id"], res["week"]))
    listed = set(zip(inj["gsis_id"], inj["week"]))
    played = set(zip(cur["gsis"], cur["week"]))
    healthy = ros[ros["status"].isin(ROSTER_OK)].drop_duplicates(["gsis_id", "week"])
    keep = [(t, w) in games and (g, w) not in hurt and (g, w) not in played and not (st == "INA" and (g, w) in listed)
            for t, w, g, st in zip(healthy["team"], healthy["week"], healthy["gsis_id"], healthy["status"])]
    zero = healthy[keep].rename(columns={"gsis_id": "gsis"}).assign(**{c: 0.0 for c in sides})
    rows = pd.concat([cur[["gsis", "team", "week"] + sides], zero[["gsis", "team", "week"] + sides]], ignore_index=True)
    # a game he left hurt: below his usual share, right before the next game his team played without him hurt-free
    weeks = {}
    for t, w in sorted(games):
        weeks.setdefault(t, []).append(w)
    nxt = {(t, w): next((x for x in weeks.get(t, []) if x > w), None) for t, w in games}
    share = rows[sides].max(axis=1)
    before_hurt = pd.Series([(g, nxt.get((t, w))) in hurt for g, t, w in zip(rows["gsis"], rows["team"], rows["week"])], index=rows.index)
    on_report = pd.Series([(g, w) in listed for g, w in zip(rows["gsis"], rows["week"])], index=rows.index)
    latest = rows["week"] == rows["team"].map({t: max(ws) for t, ws in weeks.items()})
    tot, cnt = share.groupby(rows["gsis"]).transform("sum"), share.groupby(rows["gsis"]).transform("size")
    others = ((tot - share) / (cnt - 1).where(cnt > 1)).fillna(np.inf)
    hurt_game = (before_hurt & (share < others)) | (on_report & (share < PLAYED_HURT * others)) | \
        (latest & (share < LEFT_HURT * others) & np.isfinite(others))
    rows = rows[~hurt_game]
    rows = rows.assign(w=ROLE_RECENCY ** (rows["week"].max() - rows["week"]))
    out = rows.groupby("gsis").apply(lambda g: pd.Series({k: (g[k] * g["w"]).sum() / g["w"].sum() for k in sides}),
                                     include_groups=False).rename(columns={"offense_pct": "o", "defense_pct": "d", "st_pct": "st"})
    prev = sn[sn["season"] == season - 1].assign(gsis=lambda d: d["pfr_player_id"].map(pfr_to_gsis)).dropna(subset=["gsis"])
    prev = (prev.groupby("gsis")[sides].mean() * PRIOR_ROLE).rename(columns={"offense_pct": "po", "defense_pct": "pd", "st_pct": "pst"})
    return out.join(prev, how="outer")


def power_ratings(season: int) -> tuple[dict, float]:
    """Team strength in points from this season's closing spreads (home margin = HFA + p_home - p_away)."""
    games = pd.read_csv(config.RAW_DIR / "games.csv")
    g = games[games["season"].isin([season - 1, season]) & games["spread_line"].notna()]
    teams = sorted(set(g["home_team"]) | set(g["away_team"]))
    ix = {t: i for i, t in enumerate(teams)}
    X = np.zeros((len(g), len(teams) + 1))
    for r, (h, a) in enumerate(zip(g["home_team"], g["away_team"])):
        X[r, ix[h]], X[r, ix[a]] = 1.0, -1.0
    X[:, -1] = (1.0 - g["location"].eq("Neutral").to_numpy()) if "location" in g.columns else 1.0
    w = np.where(g["season"] == season, 1.0, PRIOR_SEASON_SPREADS)
    y = g["spread_line"].to_numpy(float)
    lam = 2.0                                   # ridge: keeps teams with few games near average
    A = X.T @ (X * w[:, None]) + lam * np.diag(np.r_[np.ones(len(teams)), 0.0])
    beta = np.linalg.solve(A, X.T @ (w * y))
    p = beta[:-1] - beta[:-1].mean()
    return {t: float(p[ix[t]]) for t in teams}, float(beta[-1])


COACH_FIX = {"Klint Kubliak": "Klint Kubiak"}      # spelling errors in the nflverse schedule


def head_coaches(season: int) -> dict:
    games = pd.read_csv(config.RAW_DIR / "games.csv")
    g = games[(games["season"] == season) & games["home_score"].notna()].sort_values(["week"])
    out = {}
    for _, r in g.iterrows():
        out[r["home_team"]] = CO.coach_name(r["home_coach"], r["home_team"], season)
        out[r["away_team"]] = CO.coach_name(r["away_coach"], r["away_team"], season)
    return out


OL_SLOTS = ["LT", "LG", "C", "RG", "RT"]
OL_GUESS = {"T": ["LT", "RT"], "G": ["LG", "RG"], "C": ["C"], "OL": OL_SLOTS}


POS_NORM = {"HB": "RB", "FB": "FB", "RB": "RB", "WR": "WR", "TE": "TE", "QB": "QB", "T": "T", "OT": "T", "G": "G", "OG": "G",
            "C": "C", "OL": "OL", "DE": "DE", "DT": "DT", "NT": "NT", "DL": "DL", "LB": "LB", "ILB": "LB", "MLB": "LB",
            "OLB": "OLB", "CB": "CB", "DB": "CB", "S": "S", "FS": "S", "SS": "S", "SAF": "S"}
DC_BONUS = {1: 0.3, 2: 0.1}      # the depth chart breaks close calls: listed starters first, then the next man up


def _def_group(R, rt, pfr, pos):
    return (R.role.get(pfr) or rt["grp"].get(pfr) or ("EDGE" if pos in ("DE", "OLB") else "DL" if pos in ("DT", "NT", "DL")
            else "LB" if pos == "LB" else "CB" if pos == "CB" else "S" if pos == "S" else None))


def _line(ol: pd.DataFrame, dc: pd.DataFrame, dc_since: pd.DataFrame | None) -> list:
    """The five linemen and their slots, LT to RT, as [(gsis id, slot)]. They are the five best (`ol`,
    sorted best first) when each can take a different slot he is listed at; when they cannot (a hurt
    starter and the man filling in for him, both listed only at the same spot), one of them gives way to
    the best lineman listed at the open slot, keeping the five's score highest. A listing is any spot on
    today's chart (the higher, the likelier) or a starting spot since the preseason; a lineman listed
    nowhere can play his position's slots."""
    was = dc_since[dc_since["pos_rank"] == 1] if dc_since is not None else dc.iloc[0:0]
    pref = {}
    for g in ol.index:
        p_ = {sl: 2.5 for sl in was.loc[was["gsis_id"] == g, "pos_abb"] if sl in OL_SLOTS}
        for sl, r in dc.loc[dc["gsis_id"] == g, ["pos_abb", "pos_rank"]].itertuples(index=False):
            if sl in OL_SLOTS:
                p_[sl] = max(p_.get(sl, 0.0), {1: 3.0, 2: 2.0}.get(r, 1.0))
        pref[g] = p_ or {sl: 0.5 for sl in OL_GUESS.get(ol.at[g, "pos"], OL_SLOTS)}

    def place(five):          # the likeliest slots for these five, and whether each is at one of his
        n, _, perm = max((sum(sl in pref[g] for g, sl in zip(five, pm)), sum(pref[g].get(sl, 0.0) for g, sl in zip(five, pm)), pm)
                         for pm in permutations(OL_SLOTS, len(five)))
        return perm, n == len(five)

    five = list(ol.index[:5])
    if len(five) == 5 and not place(five)[1]:
        swaps = sorted(((ol.at[c, "sc"] - ol.at[m, "sc"], [c if g == m else g for g in five]) for m in five for c in ol.index[5:]),
                       key=lambda x: -x[0])
        five = next((f for _, f in swaps if place(f)[1]), five)
    return sorted(zip(five, place(five)[0]), key=lambda x: OL_SLOTS.index(x[1]))


def lineup_now(R: PL.Ratings, team: str, season: int, avail_gsis: set, role: pd.DataFrame, hurt: set,
               dc_team: pd.DataFrame | None, roster: pd.DataFrame, dc_since: pd.DataFrame | None = None,
               ovr: pd.Series | None = None) -> dict:
    """The 22 who play for `team`, injuries ignored. Candidates are the players on the team (see
    `_available`), each scored by his usual role (`roles`), a bonus for his depth-chart rank and a little
    for how good he is (better players start). A player who is out keeps the bigger of this season's and
    last season's role and his best depth-chart rank since the preseason (`dc_since`, the team's chart
    since then), since ESPN moves injured players down the chart, and his rating counts more. The line
    has one man per slot (`_line`). The personnel (how many backs, receivers, tight ends,
    linebackers, corners, safeties) is what the team has used most lately."""
    sn_all = R.T["snaps"]
    sn = sn_all[(sn_all["season"] == season) & (sn_all["team"] == team)].copy()
    sn["pos"] = sn["position"].map(POS_NORM).fillna(sn["position"])
    games = sn.drop_duplicates("game_id").sort_values("week")["game_id"].tolist()[-RECENT_GAMES:]
    wts = {gid: RECENCY ** (len(games) - 1 - i) for i, gid in enumerate(games)}
    sn = sn[sn["game_id"].isin(games)].assign(w=lambda d: d["game_id"].map(wts))
    rt = R.now(season)
    pfr_to_gsis = {v: k for k, v in R.gsis_to_pfr.items()}
    ros = roster[(roster["team"] == team) & roster["gsis_id"].isin(avail_gsis)].drop_duplicates("gsis_id")

    # team personnel: expected players per group on a recent snap
    tot_w = sum(wts.values())
    sn["og"] = sn["pos"].replace({"FB": "RB"})
    sn["dg"] = [_def_group(R, rt, pf, ps) for pf, ps in zip(sn["pfr_player_id"], sn["pos"])]
    exp_off = (sn["offense_pct"] * sn["w"]).groupby(sn["og"]).sum() / tot_w
    exp_def = (sn["defense_pct"] * sn["w"]).groupby(sn["dg"]).sum() / tot_w

    # candidates: the team's players with their usual roles, latest position and depth-chart rank
    last = sn_all.sort_values(["season", "week"]).assign(gsis=lambda d: d["pfr_player_id"].map(pfr_to_gsis)).dropna(subset=["gsis"])
    last = last.drop_duplicates("gsis", keep="last").set_index("gsis")
    cand = ros.set_index("gsis_id")[["full_name", "position"]].join(role, how="left")
    is_hurt = cand.index.isin(hurt)
    for c, pc in (("o", "po"), ("d", "pd"), ("st", "pst")):
        now_, prev_ = cand[c], cand[pc]
        cand[c] = np.where(is_hurt, np.fmax(now_.fillna(0.0), prev_.fillna(0.0)), now_.fillna(prev_).fillna(0.0))
    cand["pos"] = last["position"].reindex(cand.index).map(POS_NORM)
    cand["pfr"] = pd.Series(cand.index.map(R.gsis_to_pfr), index=cand.index)
    ros_pos = cand["position"].map({"RB": "RB", "FB": "FB", "WR": "WR", "TE": "TE", "QB": "QB", "OL": "OL", "T": "T", "G": "G",
                                    "C": "C", "DL": "DL", "DE": "DE", "DT": "DT", "NT": "NT", "LB": "LB", "OLB": "OLB",
                                    "DB": "CB", "CB": "CB", "S": "S", "SAF": "S", "K": "K", "P": "P"})
    cand["pos"] = cand["pos"].fillna(ros_pos)
    cand.loc[cand["position"].isin(["QB", "K", "P"]), "pos"] = cand["position"]     # the roster's word on these
    dc = dc_team if dc_team is not None else pd.DataFrame(columns=["gsis_id", "pos_rank", "pos_abb", "pos_grp"])
    dc = dc[dc["pos_grp"] != "Special Teams"] if "pos_grp" in dc.columns else dc   # a kick returner is not a starting receiver
    rank = dc.groupby("gsis_id")["pos_rank"].min()
    cand["dc"] = cand.index.map(rank)
    dc_bonus = cand["dc"].map(DC_BONUS).fillna(0.0)
    if dc_since is not None:     # a hurt player's best listing since the preseason, counted a little less
        dc_best = dc_since.groupby("gsis_id")["pos_rank"].min()
        was = pd.Series(cand.index.map(dc_best), index=cand.index).map(DC_BONUS).fillna(0.0) * HURT_RANK
        dc_bonus = pd.Series(np.where(is_hurt, np.fmax(dc_bonus, was), dc_bonus), index=cand.index)
        cand.loc[is_hurt & (was > 0), "dc"] = cand["dc"].fillna(99)
    ovr = ovr if ovr is not None else pd.Series(dtype=float)
    rating = pd.Series(cand.index.map(ovr), index=cand.index).fillna(O.CENTER - 12)
    cand["bonus"] = dc_bonus + (QUALITY * (rating - O.CENTER) + is_hurt * QUALITY_OUT * (rating - O.CENTER).clip(lower=0)) / 40
    cand["ok"] = (cand["o"] > 0) | (cand["d"] > 0) | (cand["dc"] == 1)

    def rec(gid, label):
        r = cand.loc[gid]
        _, stat = rt["player"].get(r["pfr"], (None, None)) if isinstance(r["pfr"], str) else (None, None)
        return {"pos": label, "name": r["full_name"], "ovr": int(rating[gid]), "stat": stat or "Little NFL playing time yet", "id": gid}

    offense, used = [], set()
    q = cand[(cand["pos"] == "QB") & cand["ok"]].assign(sc=lambda d: d["o"] + d["bonus"]).sort_values("sc", ascending=False)
    qb_id = q.index[0] if len(q) else None
    if qb_id:
        offense.append(rec(qb_id, "QB"))
        used.add(qb_id)
    ol = cand[cand["pos"].isin(["T", "G", "C", "OL"]) & cand["ok"] & ~cand.index.isin(used)]
    ol = ol.assign(sc=ol["o"] + ol["bonus"]).sort_values("sc", ascending=False)
    _, stat = rt["ol"].get(team, (0.5, "No line data yet"))
    stat = stat.replace("Graded as a unit: ", "His line this season: ")
    for gid, slot in _line(ol, dc, dc_since):
        offense.append({"pos": slot, "name": cand.at[gid, "full_name"], "ovr": int(rating[gid]), "stat": stat, "id": gid})
        used.add(gid)
    skill = cand[cand["pos"].isin(["RB", "FB", "WR", "TE"]) & cand["ok"] & ~cand.index.isin(used)].copy()
    skill["grp"] = skill["pos"].replace({"FB": "RB"})
    skill["sc"] = skill["o"] + skill["bonus"]
    exp = {g: float(exp_off.get(g, 0.0)) for g in ("RB", "WR", "TE")}
    if (skill["grp"] == "RB").any():
        exp["RB"] = max(exp["RB"], 1.0)                   # a back in the backfield whenever the team has one
    alloc = PL._allocate(exp, 11 - len(offense), skill["grp"].value_counts().to_dict())
    for grp in ("RB", "WR", "TE"):
        for gid in skill[skill["grp"] == grp].sort_values("sc", ascending=False).head(alloc.get(grp, 0)).index:
            offense.append(rec(gid, grp))
    dfn = cand[cand["ok"] & ~cand.index.isin(used) & ~cand["pos"].isin(["QB", "K", "P"])].copy()
    dfn["grp"] = [_def_group(R, rt, pf if isinstance(pf, str) else None, ps) for pf, ps in zip(dfn["pfr"], dfn["pos"])]
    dfn = dfn[dfn["grp"].notna() & ((dfn["d"] > 0) | (dfn["dc"] == 1))]
    dfn["sc"] = dfn["d"] + dfn["bonus"]
    alloc = PL._allocate({g: float(exp_def.get(g, 0.0)) for g in ("EDGE", "DL", "LB", "CB", "S")}, 11,
                         dfn["grp"].value_counts().to_dict())
    defense = []
    for grp in ("EDGE", "DL", "LB", "CB", "S"):
        for gid in dfn[dfn["grp"] == grp].sort_values("sc", ascending=False).head(alloc.get(grp, 0)).index:
            defense.append(rec(gid, grp))
    # kicker and punter: the usual one (special-teams role), the depth chart breaking ties
    sb = cand["dc"].map(DC_BONUS).fillna(0.0) * 0.1
    spec = {k: (cand[cand["pos"] == k].assign(sc=lambda d: d["st"] + sb.reindex(d.index)).sort_values("sc", ascending=False).index[:1].tolist()
                or [None])[0] for k in ("K", "P")}
    return {"off": offense, "def": defense, "games": games, "qb": qb_id, "k": spec["K"], "p": spec["P"],
            "names": cand["full_name"].to_dict()}


def _promote(dct: pd.DataFrame, picks: dict, names: dict) -> pd.DataFrame:
    """The team's depth chart with each picked player first at his slot (added if ESPN left him off)."""
    out = dct.copy()
    dt = out["dt"].iloc[0] if len(out) else None
    for slot, gid in picks.items():
        if not gid:
            continue
        hit = (out["pos_abb"] == slot) & (out["gsis_id"] == gid)
        if hit.any():
            out.loc[hit, "pos_rank"] = 0
        else:
            row = {c: None for c in out.columns}
            row.update({"gsis_id": gid, "pos_abb": slot, "pos_rank": 0, "player_name": names.get(gid), "dt": dt,
                        "team": out["team"].iloc[0] if len(out) else None})
            out = pd.concat([out, pd.DataFrame([row])], ignore_index=True)
    return out


def teams_now(bundle, season: int) -> dict:
    """{team: everything the daily game needs about that team today}, injuries ignored."""
    S = live.load_sources(season)
    avail, ok_rows, hurt = _available(S)
    dc = S["depth_charts"]
    dc = _fix_ids(dc[dc["dt"].astype(str) >= f"{season}-{DC_FROM}"], ok_rows)
    latest = dc[dc["dt"] == dc["dt"].max()]
    all_ok = set().union(*avail.values())
    latest = latest[latest["gsis_id"].isin(all_ok)]                 # drop retired / cut / suspended listings
    cols = ["season", "week", "posteam", "defteam", "qb_dropback", "epa", "passer_id", "name"]
    pbp_raw = pd.concat([pd.read_parquet(config.RAW_DIR / f"play_by_play_{s}.parquet", columns=cols)
                         for s in (season - 2, season - 1, season)], ignore_index=True)
    R = PL.Ratings(PL.load_tables((season - 1, season)), bundle)
    role = roles(S, R, season)
    power, hfa = power_ratings(season)
    coaches = head_coaches(season)
    week_now = int(pd.read_csv(config.RAW_DIR / "games.csv").query("season == @season and home_score == home_score")["week"].max()) + 1
    no_injuries = S["injuries"].iloc[0:0]
    espn = {"starters": 0, "on_chart_now": 0, "on_chart_since_aug": 0}     # cross-check against ESPN's depth charts
    since = dc[dc["pos_grp"] != "Special Teams"]
    meas = AR.measures(R, season)
    ov = O.ratings(season, role)["ovr"]
    body = ok_rows.drop_duplicates("gsis_id").set_index("gsis_id")[["height", "weight"]]

    def styled(players: list) -> list:
        """Each player with his archetype (none for linemen); the third corner plays the slot."""
        out_, cbs = [], 0
        for x in players:
            gid = x.pop("id", None)
            cbs += x["pos"] == "CB"
            h, w = (body.loc[gid, "height"], body.loc[gid, "weight"]) if gid in body.index else (None, None)
            out_.append({**x, **AR.describe(x["pos"], AR.assign(x["pos"], meas.get(gid, {}), h, w, slot=x["pos"] == "CB" and cbs >= 3))})
        return out_
    out = {}
    for team in sorted(avail):
        dct = latest[latest["team"] == team]
        dcs = since[since["team"] == team]
        dc_best = dcs.groupby("gsis_id")["pos_rank"].min()
        lu = lineup_now(R, team, season, avail[team], role, hurt, dct, ok_rows, dcs, ov)
        ids = [x["id"] for x in lu["off"] + lu["def"]]
        espn["starters"] += len(ids)
        espn["on_chart_now"] += sum(i in set(dct["gsis_id"]) for i in ids)
        espn["on_chart_since_aug"] += sum(i in dc_best.index for i in ids)
        S2 = {**S, "depth_charts": _promote(dct, {"QB": lu["qb"], "PK": lu["k"], "P": lu["p"]}, lu["names"]),
              "injuries": no_injuries}
        rec = live.team_live(bundle, S2, pbp_raw, team, season, week_now)
        kp = R.week(season, week_now)
        out[team] = {
            "team": team, "coach": coaches.get(team), "power": round(power.get(team, 0.0), 2),
            "base": {k: round(v, 5) for k, v in rec["base"].items()},
            "qb": {"name": rec["qb"]["name"], "adjustment": round(rec["qb"]["adjustment"], 5)},
            "injury_adjustment": {k: round(v, 5) for k, v in rec["injury_adjustment"].items()},
            "kicker": {"name": rec["kicker"]["name"], "rating": round(rec["kicker"]["rating"], 4),
                       "ovr": O.specialist_ovr(kp["k"].get(rec["kicker"]["id"], 0.5))},
            "punter": {"name": rec["punter"]["name"], "rating": round(rec["punter"]["rating"], 3),
                       "ovr": O.specialist_ovr(kp["p"].get(rec["punter"]["id"], 0.5))},
            "lineup": {"off": styled(lu["off"]), "def": styled(lu["def"])},
            "recent_games": lu["games"],
        }
    return {"teams": out, "hfa": round(hfa, 2), "week": week_now, "season": season,
            "depth_chart": str(dc["dt"].max()), "roster_weeks": ok_rows.groupby("team")["week"].max().to_dict(),
            "hurt": sorted(hurt & all_ok), "espn_check": espn}
