"""Build a simulator GameContext for a real game (as-of ratings) or a hypothetical one."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.stats import norm

from . import library as L
from .sim import GameContext

TWO_PT_BASE = 0.47


@dataclass
class TeamInfo:
    team: str
    off_pass: float = 0.0
    off_rush: float = 0.0
    def_pass: float = 0.0
    def_rush: float = 0.0
    proe: float = 0.0
    kicker_rating: float = 0.0     # FG logit shift
    punter_rating: float = 0.0     # net yards over expected
    kicker: str | None = None
    punter: str | None = None


def ot_wp(home_spread: float) -> float:
    """Overtime win probability for the home team (strength matters less in a short OT)."""
    return float(0.5 + 0.5 * (norm.cdf(home_spread / 13.5) - 0.5))


def make_context(bundle, home: TeamInfo, away: TeamInfo, *, home_spread=0.0, receive_2h=1,
                 indoor=False, wind=0.0, temp=65.0, season=2025, mu_pass=None, mu_rush=None,
                 home_pass=0.0, home_rush=0.0) -> GameContext:
    lib = bundle.lib
    mu_pass = lib.mean_epa[L.KIND_PASS] if mu_pass is None else mu_pass
    mu_rush = lib.mean_epa[L.KIND_RUN] if mu_rush is None else mu_rush
    era = {L.KIND_PASS: mu_pass - lib.mean_epa[L.KIND_PASS], L.KIND_RUN: mu_rush - lib.mean_epa[L.KIND_RUN]}
    delta = np.zeros((2, 2))
    teams = (home, away)
    for i, (off, de) in enumerate(((home, away), (away, home))):
        sign = 0.5 if i == 0 else -0.5
        delta[i, L.KIND_PASS] = era[L.KIND_PASS] + off.off_pass + de.def_pass + sign * home_pass
        delta[i, L.KIND_RUN] = era[L.KIND_RUN] + off.off_rush + de.def_rush + sign * home_rush
    two = np.array([TWO_PT_BASE + 0.3 * (0.6 * delta[i, 1] + 0.4 * delta[i, 0]) for i in (0, 1)])
    return GameContext(
        home=home.team, away=away.team, home_spread=float(home_spread), receive_2h=int(receive_2h),
        indoor=bool(indoor), wind=float(wind or 0.0), temp=float(65.0 if temp is None or np.isnan(temp) else temp),
        season=int(season), delta=delta, proe=np.array([t.proe for t in teams]),
        kicker_shift=np.array([t.kicker_rating for t in teams]),
        punter_shift=np.array([t.punter_rating for t in teams]),
        two_pt=np.clip(two, 0.35, 0.6), ot_wp_home=ot_wp(home_spread),
    )


class GameContextFactory:
    """Look up as-of ratings for real games."""

    def __init__(self, bundle, pbp: pd.DataFrame):
        self.b = bundle
        tr = bundle.team_ratings
        self.tr = tr.set_index(["season", "week", "team"]).sort_index()
        self.kr = bundle.kicker_ratings.set_index(["season", "week", "kicker_player_id"]).sort_index()
        self.pr = bundle.punter_ratings.set_index(["season", "week", "punter_player_id"]).sort_index()
        g = pbp.groupby("game_id")
        self.games = g.agg(
            season=("season", "first"), week=("week", "first"), home=("home_team", "first"),
            away=("away_team", "first"), spread=("spread_line", "first"), roof=("roof", "first"),
            wind=("wind", "first"), temp=("temp", "first"), hok=("home_opening_kickoff", "first"),
            season_type=("season_type", "first"), home_coach=("home_coach", "first"),
            away_coach=("away_coach", "first"), result=("result", "first"),
        )
        # kicker / punter actually used by each team in each game
        k = pbp[pbp["kicker_player_id"].notna() & pbp["posteam"].notna()
                & pbp["play_type"].isin(["field_goal", "extra_point"])]
        self.kickers = k.groupby(["game_id", "posteam"])["kicker_player_id"].agg(lambda x: x.mode().iat[0])
        self.kicker_names = k.groupby("kicker_player_id")["kicker_player_name"].first()
        p = pbp[pbp["punter_player_id"].notna() & (pbp["play_type"] == "punt")]
        self.punters = p.groupby(["game_id", "posteam"])["punter_player_id"].agg(lambda x: x.mode().iat[0])
        self.punter_names = p.groupby("punter_player_id")["punter_player_name"].first()
        self._cache = {}

    def team_info(self, game_id: str, team: str, season: int, week: int) -> TeamInfo:
        try:
            r = self.tr.loc[(season, week, team)]
        except KeyError:
            r = None
        info = TeamInfo(team=team)
        if r is not None:
            info.off_pass, info.off_rush = float(r["off_pass"]), float(r["off_rush"])
            info.def_pass, info.def_rush = float(r["def_pass"]), float(r["def_rush"])
            info.proe = float(r["proe"])
        kid = self.kickers.get((game_id, team))
        if kid is not None:
            info.kicker = self.kicker_names.get(kid, kid)
            try:
                info.kicker_rating = float(self.kr.loc[(season, week, kid), "rating"])
            except KeyError:
                pass
        pid = self.punters.get((game_id, team))
        if pid is not None:
            info.punter = self.punter_names.get(pid, pid)
            try:
                info.punter_rating = float(self.pr.loc[(season, week, pid), "rating"])
            except KeyError:
                pass
        return info

    def for_game(self, game_id: str) -> tuple[GameContext, TeamInfo, TeamInfo]:
        if game_id in self._cache:
            return self._cache[game_id]
        g = self.games.loc[game_id]
        season, week = int(g["season"]), int(g["week"])
        home = self.team_info(game_id, g["home"], season, week)
        away = self.team_info(game_id, g["away"], season, week)
        try:
            r = self.tr.loc[(season, week, g["home"])]
            mu_pass, mu_rush = float(r["mu_pass"]), float(r["mu_rush"])
            hp, hr = float(r["home_pass"]), float(r["home_rush"])
        except KeyError:
            mu_pass = mu_rush = None
            hp = hr = 0.0
        ctx = make_context(
            self.b, home, away, home_spread=float(np.nan_to_num(g["spread"])),
            receive_2h=1 if g["hok"] == 1 else 0, indoor=g["roof"] in ("dome", "closed"),
            wind=np.nan_to_num(g["wind"]), temp=g["temp"], season=season,
            mu_pass=mu_pass, mu_rush=mu_rush, home_pass=hp, home_rush=hr,
        )
        self._cache[game_id] = (ctx, home, away)
        return self._cache[game_id]
