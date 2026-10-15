"""The two teams of a daily-game spot as they were in that real game: who was on the field and how strong
everyone was that week.

For each spot (the first snap of a real late-game drive, 2023-2026):
  * the 22 on the field: the players on that very snap (NFL participation data), and for the units not on the
    field then (the player's defense, the opponent's offense) the lineup of that team's nearest snap of the
    game; for 2026, where participation is not published yet, the players who took the most snaps in the game
    at each position, in the personnel the team used most;
  * how good each player was as of the week of the game: his overall rating (overall.ratings_asof: his play over
    the last few seasons, only games before the week, blended with his contract, draft slot and role), on the
    40-99 scale, with his place among the position's starters, his stat line (players.Ratings.week) and archetype;
  * what the simulator plays with, all as of the week of the game: the team's pass and run ratings (the last
    rating before the game), the quarterback who played and his rating against the team's usual mix, the
    kicker and punter who kicked in that game and their ratings, the team's call-by-call ratings, the real
    head coach, and the real point spread.
Nothing after the game is used (the daily game's rule, as for grading).
"""
from __future__ import annotations

import urllib.error
import urllib.request
from collections import Counter

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

from . import archetypes as AR
from . import coaches as CO
from . import config
from . import live
from . import overall as O
from . import players as PL
from . import playbook as P
from . import ratings as TR

SEASONS = (2023, 2024, 2025, 2026)     # the daily game's own seasons; a featured spot can come from any season since 2012

OL_SLOTS = ["LT", "LG", "C", "RG", "RT"]
OFF_POS = {"QB": "QB", "RB": "RB", "HB": "RB", "FB": "RB", "WR": "WR", "TE": "TE",
           "T": "T", "OT": "T", "G": "G", "OG": "G", "C": "C", "OL": "G"}
DEF_POS = {"DE": "EDGE", "OLB": "EDGE", "DT": "DL", "NT": "DL", "DL": "DL", "ILB": "LB", "MLB": "LB", "LB": "LB",
           "CB": "CB", "DB": "CB", "FS": "S", "SS": "S", "S": "S", "SAF": "S"}
UNRATED_OVR = int(O.CENTER - 12)       # a player without enough snaps yet, as in the current-roster lineups


def _ol_slots(players: list) -> list:
    """Five linemen (id, roster position) to LT, LG, C, RG, RT: centers to the middle, guards inside, tackles
    outside, filling from the next closest position; a sixth (jumbo) lineman stays an extra tackle."""
    pool = {"C": [], "G": [], "T": []}
    for pid, pos in players:
        pool[pos if pos in pool else "G"].append(pid)
    order = {"C": ["C", "G", "T"], "LG": ["G", "C", "T"], "RG": ["G", "C", "T"], "LT": ["T", "G", "C"], "RT": ["T", "G", "C"]}
    out = []
    for slot in ["C", "LG", "RG", "LT", "RT"]:
        for src in order[slot]:
            if pool[src]:
                out.append((pool[src].pop(0), slot))
                break
    extra = pool["T"] + pool["G"] + pool["C"]
    out = sorted(out, key=lambda x: OL_SLOTS.index(x[1]))
    return out + [(pid, "TE") for pid in extra]          # an extra lineman lines up as a tight end


def _participation(season: int):
    """The season's NGS participation file (2016 on), downloaded once; None when it is not published."""
    p = config.RAW_DIR / f"pbp_participation_{season}.parquet"
    if not p.exists():
        tmp = p.with_suffix(".part")
        try:
            urllib.request.urlretrieve(P.PART_URL.format(season=season), tmp)
        except urllib.error.HTTPError:
            return None
        tmp.replace(p)
    return p


class History:
    def __init__(self, bundle, lib: pd.DataFrame, seasons=SEASONS, pbp: pd.DataFrame | None = None):
        """seasons: every season a spot can come from; pbp: the enriched play-by-play (data.load) covering them, for
        the team ratings of seasons before the bundle's."""
        self.bundle, self.lib = bundle, lib
        self.seasons, self.pbp_full, self.extra_tr = tuple(sorted(seasons)), pbp, {}
        self.part = {}
        for s in self.seasons:
            p = _participation(s)
            if p is not None:
                cols = ["nflverse_game_id", "play_id", "possession_team", "offense_players", "defense_players"]
                have = set(pq.read_schema(p).names)     # the files before 2023 list the players but not their positions
                pos_cols = [c for c in ("offense_positions", "defense_positions") if c in have]
                f = pd.read_parquet(p, columns=cols + pos_cols)
                for c in ("offense_positions", "defense_positions"):
                    if c not in f:
                        f[c] = None
                self.part[s] = f.rename(columns={"nflverse_game_id": "game_id"})
        self.R, self.meas, self.cards, self.pbp_raw, self.ovr, self.ovr_data = {}, {}, {}, {}, {}, None
        full = pd.read_parquet(PL._get("players", "players.parquet"), columns=["gsis_id", "display_name", "height", "weight", "position"])
        full = full.drop_duplicates("gsis_id").set_index("gsis_id")
        self.names, self.body = full["display_name"].to_dict(), full[["height", "weight"]]
        self.pos_now = full["position"].dropna().to_dict()        # a player's position today: the old participation files have none
        num = pd.read_parquet(PL._get("players", "players.parquet"), columns=["gsis_id", "pfr_id", "jersey_number"]).dropna(subset=["jersey_number"])
        self.num_now = {**dict(zip(num["pfr_id"].dropna(), num["jersey_number"])), **dict(zip(num["gsis_id"], num["jersey_number"]))}
        self.jerseys = {}
        cols = ["game_id", "play_id", "season", "week", "posteam", "defteam", "play_type", "kicker_player_id",
                "punter_player_id", "passer_player_id", "qb_dropback"]
        self.pbp = pd.concat([pd.read_parquet(PL.pbp_path(s), columns=cols) for s in self.seasons], ignore_index=True)
        self.pfr_names = {}
        # participation rows of real offensive snaps only (not kicks, punts or kneels)
        scrim = self.pbp[self.pbp["play_type"].isin(["run", "pass"])][["game_id", "play_id"]]
        for s_, f in self.part.items():
            self.part[s_] = f.merge(scrim, on=["game_id", "play_id"], how="inner")

    # ---- per-season tables, as of a week
    def ratings(self, season: int) -> PL.Ratings:
        if season not in self.R:
            self.R[season] = PL.Ratings(PL.load_tables((season - 1, season)), self.bundle)
        return self.R[season]

    def overall(self, season: int, week: int) -> pd.DataFrame:
        """overall.ratings_asof for the week (ovr, pct by gsis id), cached."""
        if (season, week) not in self.ovr:
            if self.ovr_data is None:
                self.ovr_data = O.load_asof(first=min(self.seasons) - 4)
            self.ovr[(season, week)] = O.ratings_asof(season, week, self.ovr_data)[["ovr", "pct"]]
        return self.ovr[(season, week)]

    def measures(self, season: int) -> dict:
        if season not in self.meas:
            self.meas[season] = AR.measures(self.ratings(season), season)
        return self.meas[season]

    def card(self, season: int, week: int) -> pd.DataFrame:
        if (season, week) not in self.cards:
            self.cards[(season, week)] = P.call_ratings(self.lib, season, week)
        return self.cards[(season, week)]

    def raw(self, season: int) -> pd.DataFrame:
        if season not in self.pbp_raw:
            cols = ["season", "week", "posteam", "defteam", "qb_dropback", "epa", "passer_id", "name"]
            self.pbp_raw[season] = pd.concat([pd.read_parquet(PL.pbp_path(s), columns=cols)
                                              for s in PL.pbp_seasons((season - 2, season - 1, season))], ignore_index=True)
        return self.pbp_raw[season]

    # ---- who was on the field
    def _game_positions(self, R: PL.Ratings, game_id: str) -> dict:
        """Each player's position in that game, from its snap counts (the participation files before 2023 give none)."""
        sn = R.T["snaps"]
        g = sn[sn["game_id"] == game_id]
        to_gsis = {v: k for k, v in R.gsis_to_pfr.items()}
        return {to_gsis.get(p, "pfr:" + p): pos for p, pos in zip(g["pfr_player_id"], g["position"])}

    def _snap_units(self, game_id: str, season: int, play_id: float, team: str, pos_of: dict | None = None) -> dict:
        """{'off': [(gsis, pos)], 'def': [(gsis, pos)]} for `team`: the given snap when it is on the field for it,
        else the nearest snap of the game where that unit was; pos_of fills in positions the file does not give."""
        f = self.part.get(season)
        if f is None:
            return {}
        g = f[(f["game_id"] == game_id) & f["offense_players"].notna()]
        if not len(g):
            return {}
        out = {}
        for unit, mine in (("off", g["possession_team"] == team), ("def", g["possession_team"] != team)):
            rows = g[mine]
            if not len(rows):
                continue
            r = rows.iloc[int(np.argmin(np.abs(rows["play_id"].to_numpy(float) - float(play_id))))]
            ids = str(r["offense_players" if unit == "off" else "defense_players"]).split(";")
            pc = r["offense_positions" if unit == "off" else "defense_positions"]
            pos = str(pc).split(";") if isinstance(pc, str) and pc else [(pos_of or {}).get(i) or self.pos_now.get(i, "") for i in ids]
            if len(ids) == len(pos) == 11:
                out[unit] = list(zip(ids, pos))
        return out

    def _bench(self, R: PL.Ratings, game_id: str, team: str, on_field: list) -> list:
        """The skill players of the game not on the field for the snap, most snaps first: two tight ends, two backs
        (a fullback first) and two receivers. The daily game swaps them in when you change the personnel."""
        sn = R.T["snaps"]
        g = sn[(sn["game_id"] == game_id) & (sn["team"] == team) & (sn["offense_snaps"] > 0)].sort_values("offense_snaps", ascending=False)
        to_gsis = {v: k for k, v in R.gsis_to_pfr.items()}
        have = {i for i, _ in on_field}
        out = []
        for grp, n in (("TE", 2), ("RB", 2), ("WR", 2)):
            rows = g[g["position"].map(OFF_POS).fillna("") == grp]
            if grp == "RB":
                rows = rows.assign(fb=rows["position"] == "FB").sort_values(["fb", "offense_snaps"], ascending=False)
            k = 0
            for r in rows.itertuples():
                gid = to_gsis.get(r.pfr_player_id, "pfr:" + r.pfr_player_id)
                if gid in have or r.pfr_player_id in have or k >= n:
                    continue
                out.append((gid, "FB" if r.position == "FB" else grp))
                k += 1
        return out

    def _snapcount_units(self, R: PL.Ratings, game_id: str, team: str) -> dict:
        """The most-used players of the game at each position, in the personnel used most (2026 and gaps)."""
        sn = R.T["snaps"]
        g = sn[(sn["game_id"] == game_id) & (sn["team"] == team)]
        to_gsis = {v: k for k, v in R.gsis_to_pfr.items()}
        out = {}
        off = g[g["offense_snaps"] > 0].sort_values("offense_snaps", ascending=False)
        if len(off):
            picks = []
            pos = off["position"].map(OFF_POS).fillna("WR")
            qb = off[pos == "QB"].head(1)
            picks += [(r.pfr_player_id, "QB") for r in qb.itertuples()]
            ol = off[pos.isin(["T", "G", "C"])].head(5)
            picks += [(r.pfr_player_id, OFF_POS[r.position]) for r in ol.itertuples()]
            skill = off[pos.isin(["RB", "WR", "TE"])].assign(grp=pos[pos.isin(["RB", "WR", "TE"])])
            alloc = PL._allocate(skill.groupby("grp")["offense_pct"].sum().div(100).to_dict(), 11 - len(picks),
                                 skill["grp"].value_counts().to_dict())
            for grp in ("RB", "WR", "TE"):
                picks += [(r.pfr_player_id, grp) for r in skill[skill["grp"] == grp].head(alloc.get(grp, 0)).itertuples()]
            out["off"] = [(to_gsis.get(p, "pfr:" + p), pos_) for p, pos_ in picks]
        dfn = g[g["defense_snaps"] > 0].sort_values("defense_snaps", ascending=False)
        if len(dfn):
            grp = [R.role.get(p) or DEF_POS.get(ps, "LB") for p, ps in zip(dfn["pfr_player_id"], dfn["position"])]
            dfn = dfn.assign(grp=grp)
            alloc = PL._allocate(dfn.groupby("grp")["defense_pct"].sum().div(100).to_dict(), 11, dfn["grp"].value_counts().to_dict())
            picks = []
            for gr in ("EDGE", "DL", "LB", "CB", "S"):
                picks += [(r.pfr_player_id, gr) for r in dfn[dfn["grp"] == gr].head(alloc.get(gr, 0)).itertuples()]
            out["def"] = [(to_gsis.get(p, "pfr:" + p), gr) for p, gr in picks]
        return out

    # players credited on a play, by what they did (nflverse play-by-play columns)
    BOX_OFF = {"passer_player_id": 3.0, "rusher_player_id": 1.0, "receiver_player_id": 1.0}
    BOX_DEF = ["solo_tackle_1_player_id", "solo_tackle_2_player_id", "assist_tackle_1_player_id", "assist_tackle_2_player_id",
               "assist_tackle_3_player_id", "assist_tackle_4_player_id", "sack_player_id", "half_sack_1_player_id", "half_sack_2_player_id",
               "qb_hit_1_player_id", "qb_hit_2_player_id", "pass_defense_1_player_id", "pass_defense_2_player_id", "interception_player_id",
               "tackle_for_loss_1_player_id", "tackle_for_loss_2_player_id", "forced_fumble_player_1_player_id"]

    def _roster(self, season: int) -> pd.DataFrame:
        """The season's rosters (nflverse, 1999 on): gsis_id, team, position, years_exp; empty when not published."""
        if ("roster", season) not in self.jerseys:
            p = PL._get("rosters", f"roster_{season}.parquet", optional=True)
            cols = ["season", "team", "position", "gsis_id", "full_name", "years_exp"]
            self.jerseys[("roster", season)] = pd.read_parquet(p, columns=cols).dropna(subset=["gsis_id"]) if p is not None else pd.DataFrame(columns=cols)
        return self.jerseys[("roster", season)]

    def _boxscore_units(self, game_id: str, season: int, team: str) -> dict:
        """Before snap counts (2012): the players the play-by-play credits in the game, most involved first, at the
        positions the players table gives them; the line (never credited) and any gap from the season's roster."""
        cols = ["game_id", "posteam", "defteam", "play_type"] + list(self.BOX_OFF) + self.BOX_DEF
        g = pd.read_parquet(PL.pbp_path(season), columns=cols, filters=[("game_id", "==", game_id)])
        g = g[g["play_type"].isin(["run", "pass"])]
        ros = self._roster(season)
        ros = ros[ros["team"] == team].sort_values("years_exp", ascending=False)
        pos_of = {**self.pos_now, **dict(zip(ros["gsis_id"], ros["position"]))}
        out = {}
        # offense: the quarterback who threw most, then the backs, receivers and tight ends by touches
        off = g[g["posteam"] == team]
        cnt = Counter()
        for col, w in self.BOX_OFF.items():
            for pid in off[col].dropna():
                cnt[pid] += w
        qb = [p for p, _ in cnt.most_common() if pos_of.get(p) == "QB"][:1]
        skill = [(p, OFF_POS[pos_of[p]]) for p, _ in cnt.most_common() if p not in qb and OFF_POS.get(pos_of.get(p, "")) in ("RB", "WR", "TE")]
        line = [(p, OFF_POS[ps]) for p, ps in zip(ros["gsis_id"], ros["position"]) if OFF_POS.get(ps) in ("T", "G", "C")]
        ol = [x for x in line if x[1] == "T"][:2] + [x for x in line if x[1] == "G"][:2] + [x for x in line if x[1] == "C"][:1]
        picks = [(p, "QB") for p in qb] + ol
        groups = {"RB": 1, "WR": 3, "TE": 1}
        for p, grp in skill:
            if groups.get(grp, 0) > 0 and len(picks) < 11:
                picks.append((p, grp)); groups[grp] -= 1
        for p, grp in skill:                                   # still short: whoever else touched it
            if len(picks) >= 11:
                break
            if (p, grp) not in picks:
                picks.append((p, grp))
        for p, ps in zip(ros["gsis_id"], ros["position"]):      # still short: the roster
            if len(picks) >= 11:
                break
            if OFF_POS.get(ps) in ("QB", "RB", "WR", "TE") and all(p != q for q, _ in picks):
                picks.append((p, OFF_POS[ps]))
        if len(picks) == 11:
            out["off"] = picks
        # defense: everyone credited with a tackle, sack, hit, pass defended or pick, most first, in the groups a
        # defense fields; the roster fills a group nobody was credited in
        dfn = g[g["defteam"] == team]
        cnt = Counter()
        for col in self.BOX_DEF:
            for pid in dfn[col].dropna():
                cnt[pid] += 1
        cand = [(p, DEF_POS.get(pos_of.get(p, ""))) for p, _ in cnt.most_common()]
        cand = [(p, grp) for p, grp in cand if grp]
        want = {"EDGE": 2, "DL": 2, "LB": 3, "CB": 2, "S": 2}
        picks = []
        for p, grp in cand:
            if want.get(grp, 0) > 0:
                picks.append((p, grp)); want[grp] -= 1
        for grp, n in want.items():
            for p, ps in zip(ros["gsis_id"], ros["position"]):
                if n <= 0:
                    break
                if DEF_POS.get(ps) == grp and all(p != q for q, _ in picks):
                    picks.append((p, grp)); n -= 1
        for p, grp in cand:                                    # still short: the next most involved
            if len(picks) >= 11:
                break
            if all(p != q for q, _ in picks):
                picks.append((p, grp))
        if len(picks) == 11:
            out["def"] = picks
        return out

    def _jersey_table(self, season: int) -> dict:
        """Jersey numbers and names from nflverse weekly rosters: (id, team, week), then (id, team) for the season, as
        (number, name); ids are gsis and pfr. Empty when the season's file is not published. The name is the one he
        went by then (the players table has the current one: Zach Tom is Zach Bako-Bewele from 2026)."""
        if season not in self.jerseys:
            out = {}
            try:
                w = pd.read_parquet(PL._get("weekly_rosters", f"roster_weekly_{season}.parquet"),
                                    columns=["week", "team", "gsis_id", "pfr_id", "jersey_number", "full_name"]).dropna(subset=["jersey_number"])
            except Exception:                      # not published (yet): fall back to the current numbers
                w = pd.DataFrame(columns=["week", "team", "gsis_id", "pfr_id", "jersey_number", "full_name"])
            names = w["full_name"].where(w["full_name"].notna(), None)
            for col in ("gsis_id", "pfr_id"):
                d = w.assign(nm=names).dropna(subset=[col])
                out.update({(i, t, int(k)): (int(n), m) for i, t, k, n, m in zip(d[col], d["team"], d["week"], d["jersey_number"], d["nm"])})
                last = d.sort_values("week").drop_duplicates([col, "team"], keep="last")
                out.update({(i, t): (int(n), m) for i, t, n, m in zip(last[col], last["team"], last["jersey_number"], last["nm"])})
            self.jerseys[season] = out
        return self.jerseys[season]

    def _jersey(self, season: int, week: int, team: str, gid: str, pfr) -> tuple:
        """(number, name) as of that week; the season's, else the current number and no name."""
        t = self._jersey_table(season)
        for i in (gid, pfr):
            if i and (i, team, week) in t:
                return t[(i, team, week)]
        for i in (gid, pfr):
            if i and (i, team) in t:
                return t[(i, team)]
        n = self.num_now.get(gid) or (self.num_now.get(pfr) if pfr else None)
        return (int(n) if n is not None and n == n else None), None

    def _players(self, R, rt, season, team, unit, members, week=None) -> list:
        """Each player as the game shows him: position label, name, rating (40-99), stat line, archetype."""
        meas = self.measures(season)
        recs, cbs = [], 0
        if unit == "off":
            qb = [(i, "QB") for i, p in members if OFF_POS.get(p) == "QB"]
            ol = [(i, OFF_POS.get(p, "G")) for i, p in members if OFF_POS.get(p) in ("T", "G", "C")]
            skill = [(i, OFF_POS.get(p, "WR")) for i, p in members if OFF_POS.get(p, "WR") in ("RB", "WR", "TE")]
            placed = qb[:1] + [(i, s) for i, s in _ol_slots(ol)] + skill + qb[1:]
        else:
            placed = []
            for i, p in members:
                pfr = R.gsis_to_pfr.get(i)
                # his role today (PFF) tells an edge from an interior lineman; in an old game a corner who became a safety
                # (or the reverse) was what that game's snap counts say
                then = DEF_POS.get(p) if season < 2023 and p in ("CB", "DB", "S", "FS", "SS", "SAF") else None
                grp = then or (R.role.get(pfr) if pfr else None) or rt["grp"].get(pfr) or DEF_POS.get(p) or p
                placed.append((i, grp if grp in ("EDGE", "DL", "LB", "CB", "S") else DEF_POS.get(p, "LB")))
        line_pct, line_stat = rt["ol"].get(team, (None, None))
        ov = self.overall(season, week) if week is not None else None
        if not hasattr(self, "pfr_to_gsis"):
            self.pfr_to_gsis = {v: k for k, v in R.gsis_to_pfr.items()}
        for gid, label in placed:
            pfr = gid[4:] if gid.startswith("pfr:") else R.gsis_to_pfr.get(gid)
            if season not in self.pfr_names:
                pl = R.T["players"].dropna(subset=["pfr_id"])
                sn = R.T["snaps"].dropna(subset=["pfr_player_id"])     # names for players new to the players table
                self.pfr_names[season] = {**dict(zip(sn["pfr_player_id"], sn["player"])),
                                          **dict(zip(pl["pfr_id"], pl["display_name"]))}
            name = self.names.get(gid) or self.pfr_names[season].get(pfr, "Unknown")
            if label in OL_SLOTS:
                pct, stat = line_pct, (line_stat or "").replace("Graded as a unit: ", "His line that season: ")
            else:
                pct, stat = rt["player"].get(pfr, (None, None)) if pfr else (None, None)
            ovr = O.specialist_ovr(float(pct)) if pct is not None else UNRATED_OVR
            gsis = gid if not gid.startswith("pfr:") else self.pfr_to_gsis.get(pfr)
            if ov is not None and gsis in ov.index and np.isfinite(ov.at[gsis, "ovr"]):
                ovr, pct = ov.at[gsis, "ovr"], ov.at[gsis, "pct"]      # the overall rating, his place among starters
            num, then = self._jersey(season, week, team, gid, pfr)
            if isinstance(then, str) and then.strip():
                name = then.strip()
            rec = {"pos": label, "name": name, "ovr": int(ovr), "stat": stat or "Little NFL playing time yet"}
            if num is not None:
                rec["num"] = num
            if pct is not None:
                rec["pct"] = int(np.clip(round(float(pct) * 100), 1, 99))
            if label not in OL_SLOTS:
                cbs += label == "CB"
                h, w = (self.body.loc[gid, "height"], self.body.loc[gid, "weight"]) if gid in self.body.index else (None, None)
                group = {"TE": "TE"}.get(label, label)
                rec.update(AR.describe(group, AR.assign(group, meas.get(gid, {}), h, w, slot=label == "CB" and cbs >= 3)))
            recs.append(rec)
        return recs

    def _bench_players(self, R, rt, season, team, members, week) -> list:
        recs = self._players(R, rt, season, team, "off", members, week)
        for rec, (_, pos) in zip(recs, members):
            if pos == "FB":
                rec["pos"] = "FB"
        return recs

    # ---- the simulator's view of a team that week
    def team_ratings(self, season: int) -> pd.DataFrame:
        """The bundle's as-of team ratings (2023 on), plus the season's own fit (ratings.team_ratings on the play-by-play
        of it and the two before) for a season before them."""
        tr = self.bundle.team_ratings
        if season >= int(tr["season"].min()) or self.pbp_full is None:
            return tr
        if season not in self.extra_tr:
            p = self.pbp_full[self.pbp_full["season"].between(season - 2, season)]
            self.extra_tr[season] = TR.team_ratings(p, [season], current=False)
        return pd.concat([self.extra_tr[season], tr], ignore_index=True)

    def _strength(self, team: str, season: int, week: int, game_id: str, qb_id) -> dict:
        tr = self.team_ratings(season)
        rows = tr[(tr["team"] == team) & ((tr["season"] < season) | ((tr["season"] == season) & (tr["week"] < week)))]
        if not len(rows):          # the ratings start in 2023: a 2023 week 1 game takes the team's first rating
            rows = tr[tr["team"] == team].sort_values(["season", "week"]).head(1)
        r = rows.sort_values(["season", "week"]).iloc[-1]
        raw = self.raw(season)
        qbr = live.qb_ratings(raw, tr, season, week).set_index("passer_id")
        mix = live.team_qb_mix(raw, team, season, week)
        mix_rating = float(sum(sh * qbr["rating"].get(pid, live.QB_PRIOR_MEAN) for pid, sh in mix.items()))
        qb_rating = float(qbr["rating"].get(qb_id, live.QB_PRIOR_MEAN)) if qb_id else mix_rating
        g = self.pbp[(self.pbp["game_id"] == game_id) & (self.pbp["posteam"] == team)]

        def specialist(col, tab, key):
            # the kicker of the team's field goals and extra points (on kickoffs the data credits the kick to the
            # receiving team), else of its kickoffs; the punter of its punts
            kick = g[g["play_type"].isin(["field_goal", "extra_point"])] if col == "kicker_player_id" else g
            ids = kick[col].dropna()
            if not len(ids) and col == "kicker_player_id":
                ids = self.pbp[(self.pbp["game_id"] == game_id) & (self.pbp["defteam"] == team) & (self.pbp["play_type"] == "kickoff")][col].dropna()
            if not len(ids):        # no kick of that kind in the game: the team's latest one before it, else its next
                own = self.pbp[(self.pbp["posteam"] == team) & self.pbp[col].notna() & (self.pbp["season"] == season)]
                if col == "kicker_player_id":
                    own = own[own["play_type"].isin(["field_goal", "extra_point"])]
                before = own[own["week"] <= week]
                ids = (before[before["week"] == before["week"].max()] if len(before) else own[own["week"] == own["week"].min()])[col]
            pid = Counter(ids).most_common(1)[0][0] if len(ids) else None
            t = tab[(tab[key] == pid) & ((tab["season"] < season) | ((tab["season"] == season) & (tab["week"] < week)))]
            rating = float(t.sort_values(["season", "week"])["rating"].iloc[-1]) if len(t) else 0.0
            wk = tab[(tab["season"] == season) & (tab["week"] == tab.loc[(tab["season"] == season) & (tab["week"] < week), "week"].max())]
            pct = float((wk["rating"] < rating).mean()) if len(wk) else 0.5
            return {"name": self.names.get(pid), "rating": round(rating, 4), "ovr": O.specialist_ovr(pct)}
        return {
            "base": {k: round(float(r[k]), 5) for k in ("off_pass", "off_rush", "def_pass", "def_rush", "proe")},
            "qb": {"name": self.names.get(qb_id), "adjustment": round(live.QB_SHARE_OF_PASSING * (qb_rating - mix_rating), 5)},
            "injury_adjustment": {"off_pass": 0.0, "off_rush": 0.0, "def_pass": 0.0, "def_rush": 0.0},
            "kicker": specialist("kicker_player_id", self.bundle.kicker_ratings, "kicker_player_id"),
            "punter": specialist("punter_player_id", self.bundle.punter_ratings, "punter_player_id"),
            "league": {k: round(float(r[k]), 5) for k in ("mu_pass", "mu_rush", "home_pass", "home_rush")},
        }

    def teams(self, game_id: str, season: int, week: int, play_id: float, home: str, away: str, coaches: dict) -> dict:
        """{'home': team, 'away': team} in the daily game's team format, as of that game."""
        R = self.ratings(season)
        rt = R.week(season, week)
        card = self.card(season, week)
        out = {}
        for side, team in (("home", home), ("away", away)):
            units = self._snap_units(game_id, season, play_id, team, self._game_positions(R, game_id) if season < 2023 else None)
            if len(units) < 2:
                units = {**self._snapcount_units(R, game_id, team), **units}
            if len(units) < 2:
                units = {**self._boxscore_units(game_id, season, team), **units}
            off, dfn = units.get("off", []), units.get("def", [])
            qb_id = next((i for i, p in off if OFF_POS.get(p) == "QB"), None)
            if qb_id is None or qb_id.startswith("pfr:"):
                d = self.pbp[(self.pbp["game_id"] == game_id) & (self.pbp["posteam"] == team) & (self.pbp["qb_dropback"] == 1)]
                ids = d["passer_player_id"].dropna()
                qb_id = Counter(ids).most_common(1)[0][0] if len(ids) else None
            st = self._strength(team, season, week, game_id, qb_id)
            out[side] = {
                "team": team, "coach": CO.COACH_FIX.get(coaches.get(side), coaches.get(side)), "base": st["base"], "qb": st["qb"],
                "injury_adjustment": st["injury_adjustment"], "kicker": st["kicker"], "punter": st["punter"],
                "lineup": {"off": self._players(R, rt, season, team, "off", off, week),
                           "def": self._players(R, rt, season, team, "def", dfn, week),
                           "bench": self._bench_players(R, rt, season, team, self._bench(R, game_id, team, off), week)},
                "calls": {c: {"off": v["off"], "def": v["def"]} for c, v in P.team_card(card, team).items()},
            }
            league = st["league"]
        return {"teams": out, "league": league}
