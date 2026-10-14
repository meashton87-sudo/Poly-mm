"""The two teams of a daily-game spot as they were in that real game: who was on the field and how strong
everyone was that week.

For each spot (the first snap of a real late-game drive, 2023-2026):
  * the 22 on the field: the players on that very snap (NFL participation data), and for the units not on the
    field then (the player's defense, the opponent's offense) the lineup of that team's nearest snap of the
    game; for 2026, where participation is not published yet, the players who took the most snaps in the game
    at each position, in the personnel the team used most;
  * how good each player was: his percentile among the league at his position as of the week of the game
    (players.Ratings.week: only games before it), on the 40-99 scale, with his stat line and archetype;
  * what the simulator plays with, all as of the week of the game: the team's pass and run ratings (the last
    rating before the game), the quarterback who played and his rating against the team's usual mix, the
    kicker and punter who kicked in that game and their ratings, the team's call-by-call ratings, the real
    head coach, and the real point spread.
Nothing after the game is used (the daily game's rule, as for grading).
"""
from __future__ import annotations

from collections import Counter

import numpy as np
import pandas as pd

from . import archetypes as AR
from . import config
from . import live
from . import overall as O
from . import players as PL
from . import playbook as P

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


class History:
    def __init__(self, bundle, lib: pd.DataFrame):
        self.bundle, self.lib = bundle, lib
        self.part = {}
        for s in (2023, 2024, 2025, 2026):
            p = config.RAW_DIR / f"pbp_participation_{s}.parquet"
            if p.exists():
                f = pd.read_parquet(p, columns=["nflverse_game_id", "play_id", "possession_team", "offense_players",
                                                "offense_positions", "defense_players", "defense_positions"])
                self.part[s] = f.rename(columns={"nflverse_game_id": "game_id"})
        self.R, self.meas, self.cards, self.pbp_raw = {}, {}, {}, {}
        full = pd.read_parquet(PL._get("players", "players.parquet"), columns=["gsis_id", "display_name", "height", "weight"])
        full = full.drop_duplicates("gsis_id").set_index("gsis_id")
        self.names, self.body = full["display_name"].to_dict(), full[["height", "weight"]]
        cols = ["game_id", "play_id", "season", "week", "posteam", "defteam", "play_type", "kicker_player_id",
                "punter_player_id", "passer_player_id", "qb_dropback"]
        self.pbp = pd.concat([pd.read_parquet(config.RAW_DIR / f"play_by_play_{s}.parquet", columns=cols)
                              for s in (2023, 2024, 2025, 2026)], ignore_index=True)
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
            self.pbp_raw[season] = pd.concat([pd.read_parquet(config.RAW_DIR / f"play_by_play_{s}.parquet", columns=cols)
                                              for s in (season - 2, season - 1, season)], ignore_index=True)
        return self.pbp_raw[season]

    # ---- who was on the field
    def _snap_units(self, game_id: str, season: int, play_id: float, team: str) -> dict:
        """{'off': [(gsis, pos)], 'def': [(gsis, pos)]} for `team`: the given snap when it is on the field for it,
        else the nearest snap of the game where that unit was."""
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
            pos = str(r["offense_positions" if unit == "off" else "defense_positions"]).split(";")
            if len(ids) == len(pos) == 11:
                out[unit] = list(zip(ids, pos))
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

    def _players(self, R, rt, season, team, unit, members) -> list:
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
                grp = (R.role.get(pfr) if pfr else None) or rt["grp"].get(pfr) or DEF_POS.get(p) or p
                placed.append((i, grp if grp in ("EDGE", "DL", "LB", "CB", "S") else DEF_POS.get(p, "LB")))
        line_pct, line_stat = rt["ol"].get(team, (None, None))
        for gid, label in placed:
            pfr = gid[4:] if gid.startswith("pfr:") else R.gsis_to_pfr.get(gid)
            if season not in self.pfr_names:
                pl = R.T["players"].dropna(subset=["pfr_id"])
                self.pfr_names[season] = dict(zip(pl["pfr_id"], pl["display_name"]))
            name = self.names.get(gid) or self.pfr_names[season].get(pfr, "Unknown")
            if label in OL_SLOTS:
                pct, stat = line_pct, (line_stat or "").replace("Graded as a unit: ", "His line that season: ")
            else:
                pct, stat = rt["player"].get(pfr, (None, None)) if pfr else (None, None)
            ovr = O.specialist_ovr(float(pct)) if pct is not None else UNRATED_OVR
            rec = {"pos": label, "name": name, "ovr": int(ovr), "stat": stat or "Little NFL playing time yet"}
            if pct is not None:
                rec["pct"] = int(round(float(pct) * 100))
            if label not in OL_SLOTS:
                cbs += label == "CB"
                h, w = (self.body.loc[gid, "height"], self.body.loc[gid, "weight"]) if gid in self.body.index else (None, None)
                group = {"TE": "TE"}.get(label, label)
                rec.update(AR.describe(group, AR.assign(group, meas.get(gid, {}), h, w, slot=label == "CB" and cbs >= 3)))
            recs.append(rec)
        return recs

    # ---- the simulator's view of a team that week
    def _strength(self, team: str, season: int, week: int, game_id: str, qb_id) -> dict:
        tr = self.bundle.team_ratings
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
            units = self._snap_units(game_id, season, play_id, team)
            if len(units) < 2:
                units = {**self._snapcount_units(R, game_id, team), **units}
            off, dfn = units.get("off", []), units.get("def", [])
            qb_id = next((i for i, p in off if OFF_POS.get(p) == "QB"), None)
            if qb_id is None or qb_id.startswith("pfr:"):
                d = self.pbp[(self.pbp["game_id"] == game_id) & (self.pbp["posteam"] == team) & (self.pbp["qb_dropback"] == 1)]
                ids = d["passer_player_id"].dropna()
                qb_id = Counter(ids).most_common(1)[0][0] if len(ids) else None
            st = self._strength(team, season, week, game_id, qb_id)
            out[side] = {
                "team": team, "coach": coaches.get(side), "base": st["base"], "qb": st["qb"],
                "injury_adjustment": st["injury_adjustment"], "kicker": st["kicker"], "punter": st["punter"],
                "lineup": {"off": self._players(R, rt, season, team, "off", off), "def": self._players(R, rt, season, team, "def", dfn)},
                "calls": {c: {"off": v["off"], "def": v["def"]} for c, v in P.team_card(card, team).items()},
            }
            league = st["league"]
        return {"teams": out, "league": league}
