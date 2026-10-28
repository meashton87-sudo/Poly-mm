"""Build web/hoops/hoops_data.json from NBA play-by-play.

Data: the public shufinskiy/nba_data dataset, "nbastats" source, one tar.xz per
season (nbastats_<season>.tar.xz holding nbastats_<season>.csv). The archives are
downloaded into data/raw/hoops/ when missing, or read from the directory given
with --raw.

Run:  PYTHONPATH=src python -m hoops.build [--raw DIR] [--out FILE]

What the file holds (see the README-style comment above each builder below):
  league   clutch rates (4th period or overtime, period clock <= 120 s, margin
           within 5): shooting, fouls, turnovers, rebounds, possession length,
           deliberate-foul tendencies.
  teams    every team's season-long profile for its latest season, with up to
           eight players and their shares of the team's shots.
  spots    one moment per regular-season game: the first possession that starts
           in the clutch, with everything the game needs to play it out and the
           real play-by-play to the final buzzer.
  schedule one spot per day for 400 days, a deterministic shuffle.

Everything about the data's layout is verified in `check_assumptions`, which
prints what it finds before anything is built.
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import math
import os
import random
import re
import ssl
import sys
import tarfile
import urllib.request
from collections import Counter, defaultdict
from statistics import mean, pstdev

import pandas as pd

SEASONS = [2023, 2024]  # 2023 = the 2023-24 season, 2024 = 2024-25
URL = "https://raw.githubusercontent.com/shufinskiy/nba_data/main/datasets/nbastats_{season}.tar.xz"
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RAW_DIR = os.path.join(REPO, "data", "raw", "hoops")
OUT = os.path.join(REPO, "web", "hoops", "hoops_data.json")

# Clutch, as the contract defines it: 4th period or overtime, two minutes or
# less on the period clock, score within five.
CLUTCH_SECS = 120
CLUTCH_MARGIN = 5

# EVENTMSGTYPE codes (verified against the descriptions in check_assumptions).
MADE, MISSED, FT, REBOUND, TURNOVER, FOUL, VIOLATION, SUB, TIMEOUT, JUMP = 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
EJECTION, PERIOD_START, PERIOD_END, REPLAY = 11, 12, 13, 18

# Foul kinds by EVENTMSGACTIONTYPE. The descriptions read "S.FOUL" (shooting),
# "P.FOUL" (personal), "L.B.FOUL" (loose ball), "OFF.Foul" / "Offensive Charge
# Foul", "T.FOUL"... and the action type encodes the same thing more reliably.
# "Personal" here means every non-shooting foul that counts as a team foul:
# personal, loose ball, away from play, clear path, double personal, flagrant,
# personal take and transition take fouls. The data's own team-foul counter
# ("(P2.T3)" = 2nd personal foul of the player, 3rd team foul of the period)
# counts exactly these, which check_assumptions confirms.
FOUL_SHOOTING = {2}
FOUL_PERSONAL = {0, 1, 3, 6, 9, 10, 14, 15, 28, 31}
FOUL_OFFENSIVE = {4, 26}
# Everything else (11, 12, 13, 16, 17, 18, 25, 30, 32, 33...) is a technical.

# Free throw kinds by EVENTMSGACTIONTYPE ("Free Throw 1 of 2" etc.).
FT_1OF1, FT_1OF2, FT_2OF2, FT_1OF3, FT_2OF3, FT_3OF3 = 10, 11, 12, 13, 14, 15
FT_TECHNICAL = {16, 21, 22}            # the ball does not change hands after these
FT_LAST_OF_TRIP = {FT_1OF1, FT_2OF2, FT_3OF3}  # a miss here is a live ball

# Timeouts: regular season teams get 7 per game, at most 4 in the 4th period and
# at most 2 in the last three minutes of it; each overtime gives 2 fresh ones.
TIMEOUTS_GAME, TIMEOUTS_4TH, TIMEOUTS_LAST3, TIMEOUTS_OT = 7, 4, 2, 2
TIMEOUT_REGULAR = 1  # EVENTMSGACTIONTYPE 7 is a coach's challenge, not a timeout

# City names for the data file. The data says "LA" for the Clippers and "Los
# Angeles" for the Lakers; the game must never use nicknames.
CITY_OVERRIDE = {"LAL": "Los Angeles (LAL)", "LAC": "Los Angeles (LAC)", "NYK": "New York", "BKN": "Brooklyn"}

SCHEDULE_START = dt.date(2026, 10, 29)
SCHEDULE_DAYS = 400
SCHEDULE_SEED = "hoops-2026"
SCHEDULE_FEATURED_DAYS = 60  # the first days prefer the most interesting spots

THREE = re.compile(r"\b3PT\b")
TEAM_FOUL_TAG = re.compile(r"\(P\d+\.(T(\d+)|PN)\)")


# ----------------------------------------------------------------------------
# Loading
# ----------------------------------------------------------------------------

COLUMNS = ["GAME_ID", "EVENTNUM", "EVENTMSGTYPE", "EVENTMSGACTIONTYPE", "PERIOD", "PCTIMESTRING",
           "HOMEDESCRIPTION", "NEUTRALDESCRIPTION", "VISITORDESCRIPTION", "SCORE", "SCOREMARGIN",
           "PLAYER1_ID", "PLAYER1_NAME", "PLAYER1_TEAM_CITY", "PLAYER1_TEAM_ABBREVIATION",
           "PLAYER2_ID", "PLAYER2_NAME", "PLAYER2_TEAM_ABBREVIATION",
           "PLAYER3_ID", "PLAYER3_NAME", "PLAYER3_TEAM_ABBREVIATION"]


def fetch_season(season: int, raw_dir: str) -> str:
    """Return the path of the season's tar.xz, downloading it into raw_dir if missing."""
    path = os.path.join(raw_dir, f"nbastats_{season}.tar.xz")
    if os.path.exists(path):
        return path
    os.makedirs(raw_dir, exist_ok=True)
    url = URL.format(season=season)
    print(f"downloading {url} -> {path}")
    ctx = ssl.create_default_context()  # honours SSL_CERT_FILE / the proxy's CA bundle
    with urllib.request.urlopen(url, context=ctx, timeout=120) as r, open(path + ".part", "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    os.replace(path + ".part", path)
    return path


def load_season(season: int, raw_dir: str) -> pd.DataFrame:
    """Read a season's play-by-play. A CSV next to the archive is used as is;
    otherwise the CSV is read straight out of the tar.xz."""
    csv = os.path.join(raw_dir, f"nbastats_{season}.csv")
    if os.path.exists(csv):
        print(f"reading {csv}")
        df = pd.read_csv(csv, usecols=COLUMNS, low_memory=False)
    else:
        tar = fetch_season(season, raw_dir)
        print(f"reading {tar}")
        with tarfile.open(tar, "r:xz") as t:
            member = next(m for m in t.getmembers() if m.name.endswith(".csv"))
            df = pd.read_csv(io.BytesIO(t.extractfile(member).read()), usecols=COLUMNS, low_memory=False)
    # Keep the file's order (it is chronological; EVENTNUM is not always), but make
    # every game one contiguous block.
    df = df.sort_values("GAME_ID", kind="stable").reset_index(drop=True)
    # Regular season only: game ids starting with "2".
    df = df[df.GAME_ID.astype(str).str.startswith("2")].reset_index(drop=True)
    df["season"] = season
    return df


# ----------------------------------------------------------------------------
# Events
# ----------------------------------------------------------------------------

class Ev:
    """One play-by-play row, normalised."""
    __slots__ = ("i", "num", "type", "action", "period", "clock", "hd", "vd", "text", "pre", "score",
                 "team", "side", "p1", "p1team", "p2", "p2team", "p3", "p3team", "is3", "made", "foul")

    def __repr__(self):
        return f"Ev({self.period} {self.clock} t{self.type}/{self.action} {self.team} {self.text!r})"


def _s(x):
    """A string cell or None (pandas gives NaN for empty cells)."""
    return x if isinstance(x, str) and x != "" else None


def clock_secs(pc: str) -> float:
    m, s = pc.split(":")
    return int(m) * 60 + int(s)


def foul_kind(action: int) -> str:
    if action in FOUL_SHOOTING:
        return "shooting"
    if action in FOUL_PERSONAL:
        return "personal"
    if action in FOUL_OFFENSIVE:
        return "offensive"
    return "technical"


class Game:
    """A game's events plus what is derived from them (teams, possessions)."""

    def __init__(self, gid: int, season: int, rows):
        self.gid, self.season = gid, season
        self.events: list[Ev] = []
        home_votes, away_votes = Counter(), Counter()
        score = (0, 0)  # (home, away)
        for i, r in enumerate(rows):
            e = Ev()
            e.i, e.num, e.type, e.action, e.period = i, int(r.EVENTNUM), int(r.EVENTMSGTYPE), int(r.EVENTMSGACTIONTYPE), int(r.PERIOD)
            e.clock = clock_secs(r.PCTIMESTRING)
            e.hd, e.vd = _s(r.HOMEDESCRIPTION), _s(r.VISITORDESCRIPTION)
            nd = _s(r.NEUTRALDESCRIPTION)
            e.p1, e.p1team = _s(r.PLAYER1_NAME), _s(r.PLAYER1_TEAM_ABBREVIATION)
            e.p2, e.p2team = _s(r.PLAYER2_NAME), _s(r.PLAYER2_TEAM_ABBREVIATION)
            e.p3, e.p3team = _s(r.PLAYER3_NAME), _s(r.PLAYER3_TEAM_ABBREVIATION)
            # Which side's column the description sits in says whose play it is.
            e.side = "home" if (e.hd and not e.vd) else "away" if (e.vd and not e.hd) else None
            if e.p1team and e.side:
                (home_votes if e.side == "home" else away_votes)[e.p1team] += 1
            # Score carried forward: "away - home" (verified in check_assumptions).
            e.pre = score
            sc = _s(r.SCORE)
            if sc:
                a, h = sc.split(" - ")
                score = (int(h), int(a))
            e.score = score
            e.text = nd or ""
            # Shots: was it a three, was it made. A block is written in the other
            # side's column of the same row, so look at both. Free throws: made
            # unless the text starts with "MISS".
            both = (e.hd or "") + " " + (e.vd or "")
            e.is3 = e.type in (MADE, MISSED) and bool(THREE.search(both))
            e.made = e.type == MADE or (e.type == FT and not both.strip().startswith("MISS"))
            e.foul = foul_kind(e.action) if e.type == FOUL else None
            e.team = e.p1team
            self.events.append(e)
        self.home = home_votes.most_common(1)[0][0]
        self.away = away_votes.most_common(1)[0][0]
        for e in self.events:
            # Team events (team rebounds, team turnovers, timeouts) have no
            # PLAYER1 team; their side gives it.
            if e.team is None and e.side:
                e.team = self.home if e.side == "home" else self.away
            # The text of the play: the player's own side first, then the other
            # side (a block or a steal is written in the other column).
            own, other = (e.hd, e.vd) if e.team != self.away else (e.vd, e.hd)
            if own or other:
                e.text = " / ".join(t for t in (own, other) if t and t.strip())
        self.final = self.events[-1].score
        self.possessions = segment(self)

    def opp(self, team):
        return self.away if team == self.home else self.home


# ----------------------------------------------------------------------------
# Possessions
# ----------------------------------------------------------------------------

class Poss:
    """A possession: team, when it started (a terminal event of the previous one:
    made field goal, made last free throw, defensive rebound, turnover) and when
    it ended."""
    __slots__ = ("team", "period", "start", "end", "first", "last", "kind", "pre", "events")

    def __init__(self, team, period, start, first, kind, pre):
        self.team, self.period, self.start, self.first, self.kind, self.pre = team, period, start, first, kind, pre
        self.end = None
        self.last = None
        self.events = []

    @property
    def secs(self):
        return self.start - self.end

    @property
    def margin(self):
        """Offense's lead at the start (negative when trailing)."""
        return self.pre


def offense_of(e: Ev):
    """Which team an event says has the ball, or None when it says nothing."""
    if e.type in (MADE, MISSED, REBOUND, TURNOVER):
        return e.team
    if e.type == FT:
        return None if e.action in FT_TECHNICAL else e.team
    if e.type == JUMP:
        return e.p3team  # the player who gets the tip
    return None


def segment(g: Game) -> list[Poss]:
    """Cut the game into possessions, period by period.

    The ball changes hands when an event names the other team as the one with
    the ball (its shot, free throw, rebound, turnover). The new possession then
    began at the previous possession's terminal event: the made field goal, made
    free throw or turnover that ended it, or this very event when it is a
    defensive rebound or a jump ball. The first event of the new possession is
    the one right after that terminal event (often a timeout or a foul)."""
    poss: list[Poss] = []
    cur: Poss | None = None
    terminal: Ev | None = None  # latest possession-ending event inside cur
    terminal_kind = None
    period = None
    period_len = 720
    period_first = None  # the period's first event (its "Start of ... Period" row)

    def close(end_clock, last_ev):
        nonlocal cur
        if cur is not None:
            cur.end = end_clock
            cur.last = last_ev
            poss.append(cur)
        cur = None

    for e in g.events:
        if e.period != period:
            close(0, g.events[e.i - 1] if e.i else e)
            period, period_len = e.period, (720 if e.period <= 4 else 300)
            period_first = e
            terminal, terminal_kind = None, None
        if e.type == PERIOD_END:
            close(0, e)
            continue
        o = offense_of(e)
        if o is not None:
            if cur is None:
                # First possession of the period: from the period's first second.
                cur = Poss(o, period, period_len, period_first, "period", margin_for(o, e.pre, g))
            elif o != cur.team:
                if e.type in (REBOUND, JUMP):
                    t, kind = e, ("dreb" if e.type == REBOUND else "jump")
                elif terminal is not None:
                    t, kind = terminal, terminal_kind
                else:
                    t, kind = g.events[e.i - 1], "other"
                close(t.clock, t)
                nxt = g.events[t.i + 1] if t.i + 1 < len(g.events) else t
                cur = Poss(o, period, t.clock, nxt, kind, margin_for(o, t.score, g))
                terminal, terminal_kind = None, None
        if cur is not None:
            cur.events.append(e)
            # Remember the event that would end this possession.
            if e.type == MADE and e.team == cur.team:
                terminal, terminal_kind = e, "fg"
            elif e.type == FT and e.made and e.team == cur.team and e.action not in FT_TECHNICAL:
                terminal, terminal_kind = e, "ft"
            elif e.type == TURNOVER and e.team == cur.team:
                terminal, terminal_kind = e, "to"
    close(0, g.events[-1])
    return poss


def margin_for(team, score, g: Game):
    h, a = score
    return h - a if team == g.home else a - h


# ----------------------------------------------------------------------------
# Verifying the assumptions about the data
# ----------------------------------------------------------------------------

def check_assumptions(df: pd.DataFrame, games: list[Game]):
    """Print what the data actually looks like, checking every assumption the
    builder relies on. Raises when something load-bearing is off."""
    print("\n== data checks ==")
    ids = df.GAME_ID.astype(str)
    print(f"rows {len(df):,}  games {df.GAME_ID.nunique()}  id prefixes {dict(Counter(ids.str[:3]))}")
    print(f"first game id per season: {df.groupby('season').GAME_ID.min().to_dict()}")
    print(f"period clock format MM:SS: {bool(df.PCTIMESTRING.str.fullmatch(r'\d{1,2}:\d{2}').all())}")
    types = df.EVENTMSGTYPE.value_counts().sort_index().to_dict()
    print(f"EVENTMSGTYPE counts: {types}")
    assert all(t in types for t in (1, 2, 3, 4, 5, 6, 8, 9, 12, 13))
    # SCORE is "away - home": the margin column (home minus away) equals second minus first.
    s = df[df.SCORE.notna() & df.SCOREMARGIN.notna()]
    parts = s.SCORE.str.split(" - ", expand=True).astype(int)
    marg = s.SCOREMARGIN.replace("TIE", "0").astype(int)
    away_home = float((marg == parts[1] - parts[0]).mean())
    print(f"SCORE is 'away - home' (margin == second - first): {away_home:.4f}")
    assert away_home > 0.999
    print(f"SCORE present on event types: {s.EVENTMSGTYPE.value_counts().to_dict()} (also on period starts and replays, not only scoring plays)")
    H, V = df.HOMEDESCRIPTION, df.VISITORDESCRIPTION
    own = H.fillna(V).fillna("")
    for t, name in ((1, "made shot"), (2, "missed shot"), (3, "free throw")):
        sub = own[df.EVENTMSGTYPE == t]
        print(f"type {t} {name}: n={len(sub)}  'MISS' prefix {float(sub.str.startswith('MISS').mean()):.3f}  "
              f"'(n PTS)' {float(sub.str.contains(r'\(\d+ PTS\)').mean()):.3f}  '3PT' {float(sub.str.contains('3PT').mean()):.3f}")
    # Blocks and steals sit in the other side's column of the same row.
    both = (H.notna() & V.notna())
    print(f"rows with both descriptions: {int(both.sum())} (blocks on misses: {int((both & (df.EVENTMSGTYPE == 2)).sum())}, steals on turnovers: {int((both & (df.EVENTMSGTYPE == 5)).sum())})")
    ft = df[df.EVENTMSGTYPE == 3]
    print("free throw action types: " + ", ".join(f"{a}={own[ft.index[ft.EVENTMSGACTIONTYPE == a][0]].split(' Free Throw ')[-1].split(' (')[0]}" for a in sorted(ft.EVENTMSGACTIONTYPE.unique())))
    fo = df[df.EVENTMSGTYPE == 6]
    kinds = defaultdict(Counter)
    for a, d in zip(fo.EVENTMSGACTIONTYPE, own[fo.index]):
        word = re.sub(r"^\S+ ", "", d).split(" (")[0] if d else "?"
        kinds[a][word] += 1
    print("foul action types -> wording -> class:")
    for a in sorted(kinds):
        print(f"   {a:>3} {foul_kind(a):<10} n={sum(kinds[a].values()):>6}  {kinds[a].most_common(2)}")
    rb = own[df.EVENTMSGTYPE == 4]
    print(f"rebounds: 'REBOUND (Off:n Def:m)' {float(rb.str.contains(r'REBOUND \(Off:\d+ Def:\d+\)').mean()):.3f}, team rebounds ('<Team> Rebound') {float(rb.str.endswith(' Rebound').mean()):.3f}")
    to = df[df.EVENTMSGTYPE == 9]
    print(f"timeouts: action types {to.EVENTMSGACTIONTYPE.value_counts().to_dict()} (1 regular, 7 coach challenge); PLAYER1 team abbreviation present: {float(to.PLAYER1_TEAM_ABBREVIATION.notna().mean()):.2f} -> the side of the description column gives the team")
    sb = df[df.EVENTMSGTYPE == 8].head(500)
    ok = [d.split(" FOR ")[0].endswith(str(p2).split()[-1]) for d, p2 in zip(own[sb.index], sb.PLAYER2_NAME.fillna("?"))]
    print(f"substitutions 'SUB: In FOR Out': PLAYER2 is the player coming in: {mean(ok):.2f}")
    # Order: the file is chronological even where EVENTNUM is not.
    inc = 0
    for g in games:
        for a, b in zip(g.events, g.events[1:]):
            if a.period == b.period and b.clock > a.clock:
                inc += 1
    print(f"period clock increases within a period in file order: {inc} (file order is used; EVENTNUM order differs from it)")
    print(f"EVENTNUM unique within a game: {bool((df.groupby('GAME_ID').EVENTNUM.nunique() == df.groupby('GAME_ID').size()).all())}")
    # Home side from the description column agrees with every game having exactly two teams.
    print(f"teams per game: {Counter(len({e.team for e in g.events if e.team}) for g in games)}")
    # Team foul counter in the description against our count of personal + shooting fouls.
    agree = total = 0
    for g in games:
        for p in (1, 2, 3, 4, 5, 6):
            cnt = Counter()
            for e in g.events:
                if e.period != p or e.type != FOUL or e.foul not in ("shooting", "personal") or not e.team:
                    continue
                cnt[e.team] += 1
                m = TEAM_FOUL_TAG.search(e.text)
                if m and m.group(2):
                    total += 1
                    agree += int(cnt[e.team]) == int(m.group(2))
    print(f"our team-foul count equals the data's '(Pn.Tm)' m: {agree}/{total} = {agree / total:.4f}")
    # Timeouts per team per game.
    used = Counter()
    for g in games:
        for e in g.events:
            if e.type == TIMEOUT and e.action == TIMEOUT_REGULAR:
                used[(g.gid, e.team)] += 1
    print(f"regular timeouts per team per game: {dict(sorted(Counter(used.values()).items()))} (above 7 only in overtime games: each overtime adds 2)")
    over = [k for k, v in used.items() if v > 7]
    by_gid = {g.gid: g for g in games}
    print(f"   teams with >7: {len(over)}, of which in overtime games: {sum(max(e.period for e in by_gid[k[0]].events) > 4 for k in over)}")
    print(f"periods per game: {dict(Counter(max(e.period for e in g.events) for g in games))}")
    kinds = Counter(p.kind for g in games for p in g.possessions)
    print(f"possession starts by kind: {dict(kinds)}")
    print(f"possessions per game per team: {mean(len(g.possessions) / 2 for g in games):.1f}")


# ----------------------------------------------------------------------------
# Rates
# ----------------------------------------------------------------------------

def clutch(e: Ev) -> bool:
    h, a = e.pre
    return e.period >= 4 and e.clock <= CLUTCH_SECS and abs(h - a) <= CLUTCH_MARGIN


def next_rebound(g: Game, e: Ev):
    """The rebound that follows a miss (within the next few events of the period)."""
    for x in g.events[e.i + 1: e.i + 8]:
        if x.period != e.period:
            return None
        if x.type == REBOUND:
            return x
        if x.type in (MADE, MISSED, TURNOVER, PERIOD_END):
            return None
    return None


def shooting_foul_shot(g: Game, f: Ev):
    """For a shooting foul: (points of the attempt 2|3, the made shot event if it
    was an and-one, else None). Read from the free throws that follow: "1 of 1"
    means the shot went in, "1 of 2" a two, "1 of 3" a three."""
    for x in g.events[f.i + 1: f.i + 16]:
        if x.period != f.period:
            break
        if x.type == FT and x.p1 == f.p2:
            if x.action == FT_1OF1:
                for y in g.events[max(0, f.i - 6): f.i][::-1]:
                    if y.type == MADE and y.p1 == f.p2 and y.clock == f.clock:
                        return (3 if y.is3 else 2), y
                return 2, None  # an and-one whose basket we cannot find
            if x.action in (FT_1OF2, FT_2OF2):
                return 2, None
            if x.action in (FT_1OF3, FT_2OF3, FT_3OF3):
                return 3, None
            return None
    return None


def rate(num, den):
    return round(num / den, 4) if den else None


class Tally:
    """Shooting, foul, turnover and rebound counts for one scope (the clutch
    league-wide, or one team's season)."""

    def __init__(self):
        self.c = Counter()
        self.players = defaultdict(Counter)

    def shot(self, e: Ev):
        k = "3" if e.is3 else "2"
        self.c["att" + k] += 1
        self.c["made" + k] += e.made
        if e.p1:
            self.players[e.p1]["att" + k] += 1

    def ft(self, e: Ev):
        self.c["fta"] += 1
        self.c["ftm"] += e.made
        if e.p1:
            self.players[e.p1]["fta"] += 1
            self.players[e.p1]["ftm"] += e.made


def league_rates(games: list[Game]) -> dict:
    """Clutch rates across all games (event-level clutch for shots, fouls and
    rebounds; possession-level for turnovers and possession length)."""
    t = Tally()
    c = t.c
    secs = defaultdict(list)
    for g in games:
        for e in g.events:
            if not clutch(e):
                continue
            if e.type in (MADE, MISSED):
                t.shot(e)
                if e.type == MISSED:
                    r = next_rebound(g, e)
                    if r is not None and r.team:
                        c["miss_reb"] += 1
                        c["miss_oreb"] += r.team == e.team
            elif e.type == FT:
                t.ft(e)
                if not e.made and e.action in FT_LAST_OF_TRIP:
                    r = next_rebound(g, e)
                    if r is not None and r.team:
                        c["ftmiss_reb"] += 1
                        c["ftmiss_oreb"] += r.team == e.team
            elif e.type == FOUL and e.foul == "shooting":
                info = shooting_foul_shot(g, e)
                if info is None:
                    continue
                pts, made_shot = info
                c[f"sf{pts}"] += 1
                if made_shot is None:
                    c[f"sf{pts}_noshot"] += 1  # the attempt exists only as a foul
                elif pts == 2:
                    c["and1_2"] += 1
        for p in g.possessions:
            if p.period < 4 or p.start > CLUTCH_SECS or abs(p.margin) > CLUTCH_MARGIN or p.kind == "period":
                continue
            c["poss"] += 1
            c["to"] += sum(1 for e in p.events if e.type == TURNOVER and e.team == p.team)
            secs["all"].append(p.secs)
            secs["trail" if p.margin < 0 else "lead" if p.margin > 0 else "tied"].append(p.secs)
    # Deliberate fouling: the defense fouls early in a possession late in the game.
    ft_num = ft_den = u3_num = u3_den = 0
    for g in games:
        for p in g.possessions:
            if p.period < 4 or p.kind == "period":
                continue
            dmargin = -p.margin  # the defense's lead
            if p.start <= 30 and -8 <= dmargin <= -1:
                ft_den += 1
                ft_num += any(e.type == FOUL and e.foul == "personal" and e.team == g.opp(p.team)
                              and p.start - e.clock <= 4 for e in p.events)
            if p.start <= 15 and dmargin == 3:
                u3_den += 1
                u3_num += any(e.type == FOUL and e.foul in ("personal", "shooting") and e.team == g.opp(p.team)
                              and p.start - e.clock <= 6 for e in p.events)
    att2 = c["att2"] + c["sf2_noshot"]
    att3 = c["att3"] + c["sf3_noshot"]
    return {
        "p2": rate(c["made2"], c["att2"]),
        "p3": rate(c["made3"], c["att3"]),
        "ft": rate(c["ftm"], c["fta"]),
        "foul2": rate(c["sf2"], att2),
        "foul3": rate(c["sf3"], att3),
        "and1": rate(c["and1_2"], c["sf2"]),
        "to": rate(c["to"], c["poss"]),
        "oreb": rate(c["miss_oreb"], c["miss_reb"]),
        "oreb_ft": rate(c["ftmiss_oreb"], c["ftmiss_reb"]),
        "share3": rate(c["att3"], c["att2"] + c["att3"]),
        "secs": {"mean": round(mean(secs["all"]), 2), "sd": round(pstdev(secs["all"]), 2),
                 "trail": round(mean(secs["trail"]), 2), "lead": round(mean(secs["lead"]), 2),
                 "tied": round(mean(secs["tied"]), 2)},
        "foul_trailing": rate(ft_num, ft_den),
        "foul_up3": rate(u3_num, u3_den),
        "games": len(games),
        "possessions": c["poss"],
        "_n": {"att2": c["att2"], "att3": c["att3"], "fta": c["fta"], "sf2": c["sf2"], "sf3": c["sf3"],
               "miss_reb": c["miss_reb"], "ftmiss_reb": c["ftmiss_reb"], "foul_trailing": ft_den, "foul_up3": u3_den},
    }


def team_profiles(games: list[Game]) -> dict:
    """Every team's season-long profile (all periods) for the latest season it
    appears in, with up to eight players and their shares of the team's shots."""
    latest = {}
    for g in games:
        for tm in (g.home, g.away):
            latest[tm] = max(latest.get(tm, 0), g.season)
    tal = defaultdict(Tally)
    for g in games:
        for e in g.events:
            tm = e.team
            if not tm or latest[tm] != g.season:
                continue
            t = tal[tm]
            if e.type in (MADE, MISSED):
                t.shot(e)
                if e.type == MISSED:
                    r = next_rebound(g, e)
                    if r is not None and r.team:
                        t.c["miss_reb"] += 1
                        t.c["miss_oreb"] += r.team == tm
                        o = tal[g.opp(tm)]
                        if latest[g.opp(tm)] == g.season:
                            o.c["opp_miss_reb"] += 1
                            o.c["opp_miss_dreb"] += r.team != tm
            elif e.type == FT:
                t.ft(e)
        for p in g.possessions:
            if latest[p.team] != g.season:
                continue
            tal[p.team].c["poss"] += 1
            tal[p.team].c["to"] += sum(1 for e in p.events if e.type == TURNOVER and e.team == p.team)
    out = {}
    for tm in sorted(tal):
        t, c = tal[tm], tal[tm].c
        ranked = sorted(t.players.items(), key=lambda kv: -(kv[1]["att2"] + kv[1]["att3"] + 0.44 * kv[1]["fta"]))[:8]
        players = [{"name": name,
                    "att2": rate(s["att2"], c["att2"]),
                    "att3": rate(s["att3"], c["att3"]),
                    "ft": rate(s["ftm"], s["fta"]) if s["fta"] >= 20 else 0.75,
                    "fta": rate(s["fta"], c["fta"])} for name, s in ranked]
        out[tm] = {"city": None,
                   "p2": rate(c["made2"], c["att2"]), "p3": rate(c["made3"], c["att3"]), "ft": rate(c["ftm"], c["fta"]),
                   "to": rate(c["to"], c["poss"]), "oreb": rate(c["miss_oreb"], c["miss_reb"]),
                   "dreb": rate(c["opp_miss_dreb"], c["opp_miss_reb"]),
                   "share3": rate(c["att3"], c["att2"] + c["att3"]), "players": players}
    return out


def team_cities(df: pd.DataFrame) -> dict:
    cities = df.dropna(subset=["PLAYER1_TEAM_ABBREVIATION", "PLAYER1_TEAM_CITY"]) \
               .groupby("PLAYER1_TEAM_ABBREVIATION").PLAYER1_TEAM_CITY.agg(lambda s: s.mode().iloc[0]).to_dict()
    cities.update(CITY_OVERRIDE)
    return cities


# ----------------------------------------------------------------------------
# Spots
# ----------------------------------------------------------------------------

SPOT_KINDS = {"fg", "ft", "dreb", "to"}
REAL_DROP = {SUB, PERIOD_START, PERIOD_END, REPLAY}
REAL_MAX = 60


def timeouts_left(used_game, used_this_ot, period, clock):
    """Timeouts a team can still call, by the NBA's rules (see the constants)."""
    if period <= 4:
        left = TIMEOUTS_GAME - used_game
        if period == 4:
            left = min(left, TIMEOUTS_4TH)
            if clock <= 180:
                left = min(left, TIMEOUTS_LAST3)
    else:
        left = TIMEOUTS_OT - used_this_ot
    return max(0, left)


def players_on_court(g: Game, upto: int) -> dict:
    """Up to five players a side who were on the floor in the 4th period or
    overtime before event index `upto`, most recently active first. A player is
    on the floor when he does something (shot, rebound, foul, assist, steal,
    block...) or comes in on a substitution, and off it when subbed out."""
    last = {g.home: {}, g.away: {}}
    for e in g.events[: upto + 1]:
        if e.period < 4:
            continue
        if e.type == SUB:
            if e.p1team in last:
                last[e.p1team].pop(e.p1, None)        # PLAYER1 goes out
            if e.p2team in last and e.p2:
                last[e.p2team][e.p2] = e.i            # PLAYER2 comes in
            continue
        if e.type in (TIMEOUT, PERIOD_START, PERIOD_END, REPLAY, EJECTION) or e.foul == "technical":
            continue
        for name, tm in ((e.p1, e.p1team), (e.p2, e.p2team), (e.p3, e.p3team)):
            if name and tm in last:
                last[tm][name] = e.i
    return {side: [n for n, _ in sorted(last[tm].items(), key=lambda kv: -kv[1])[:5]]
            for side, tm in (("home", g.home), ("away", g.away))}


def real_log(g: Game, start: int) -> list:
    """The play-by-play from event index `start` to the final buzzer."""
    evs = [e for e in g.events[start:] if e.type not in REAL_DROP and e.text]
    for drop in ({TIMEOUT}, {VIOLATION, EJECTION}):  # thin the longest logs (overtime games)
        if len(evs) > REAL_MAX:
            evs = [e for e in evs if e.type not in drop]
    out = [{"t": float(e.clock), "p": e.period, "text": e.text, "score": list(e.score), "team": e.team} for e in evs]
    if out and out[-1]["score"] != list(g.final):
        # A basket waved off on review stays in the data as a made shot; the
        # period-end row then carries the corrected score (16 games in two seasons).
        out.append({"t": 0.0, "p": g.events[-1].period, "text": "Score corrected on review", "score": list(g.final), "team": None})
    return out


def game_spot(g: Game, n: int) -> dict | None:
    """The game's spot: the first possession of the 4th period or overtime that
    starts (after a made field goal, a made last free throw, a defensive rebound
    or a turnover) with two minutes or less left and the score within five."""
    for p in g.possessions:
        if p.period < 4 or p.kind not in SPOT_KINDS or p.start > CLUTCH_SECS or abs(p.margin) > CLUTCH_MARGIN:
            continue
        term = g.events[p.first.i - 1]  # the terminal event: the spot is right after it
        before = g.events[: p.first.i]
        used = Counter()
        used_ot = Counter()
        fouls = Counter()
        for e in before:
            if e.type == TIMEOUT and e.action == TIMEOUT_REGULAR and e.team:
                used[e.team] += 1
                if e.period == p.period and p.period > 4:
                    used_ot[e.team] += 1
            if e.type == FOUL and e.period == p.period and e.foul in ("shooting", "personal") and e.team:
                fouls[e.team] += 1
        lead = [e.text for e in before if e.type not in REAL_DROP and e.text][-2:]
        h, a = term.score
        return {
            "id": f"{g.gid}#{p.first.num}",
            "season": g.season, "date": None, "n": n,
            "home": g.home, "away": g.away, "me": p.team,
            "period": p.period, "clock": float(p.start), "score": [h, a],
            "poss": "home" if p.team == g.home else "away",
            "shotclock": 24,
            "timeouts": [timeouts_left(used[g.home], used_ot[g.home], p.period, p.start),
                         timeouts_left(used[g.away], used_ot[g.away], p.period, p.start)],
            "fouls": [fouls[g.home], fouls[g.away]],
            "lead": " · ".join(lead),
            "real": real_log(g, p.first.i),
            "final": list(g.final),
            "players": players_on_court(g, p.first.i - 1),
        }
    return None


def build_schedule(spots: list) -> dict:
    """One spot id per day for 400 days: a deterministic shuffle; the first 60
    days take the most interesting spots (20-120 s left, score within 3)."""
    rng = random.Random(SCHEDULE_SEED)
    ids = [s["id"] for s in spots]
    rng.shuffle(ids)
    by_id = {s["id"]: s for s in spots}
    featured = [i for i in ids if 20 <= by_id[i]["clock"] <= 120 and abs(by_id[i]["score"][0] - by_id[i]["score"][1]) <= 3]
    first = featured[:SCHEDULE_FEATURED_DAYS]
    taken = set(first)
    rest = [i for i in ids if i not in taken]
    order = first + rest
    return {str(SCHEDULE_START + dt.timedelta(days=d)): order[d % len(order)] for d in range(SCHEDULE_DAYS)}


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

def walk_numbers(x, path="root"):
    """Yield (path, value) for every number in a JSON tree."""
    if isinstance(x, bool):
        return
    if isinstance(x, (int, float)):
        yield path, x
    elif isinstance(x, dict):
        for k, v in x.items():
            yield from walk_numbers(v, f"{path}.{k}")
    elif isinstance(x, list):
        for i, v in enumerate(x):
            yield from walk_numbers(v, f"{path}[{i}]")


def validate(data: dict, games: list[Game]):
    bad = [(p, v) for p, v in walk_numbers(data) if v is None or (isinstance(v, float) and not math.isfinite(v))]
    assert not bad, f"non-finite numbers: {bad[:5]}"
    nulls = [p for p, v in ((p, v) for p, v in _walk_all(data)) if v is None and not p.endswith(".date") and not p.endswith(".team")]
    assert not nulls, f"unexpected nulls: {nulls[:5]}"
    finals = {g.gid: g.final for g in games}
    for s in data["spots"]:
        gid = int(s["id"].split("#")[0])
        assert s["real"], s["id"]
        assert s["real"][-1]["score"] == s["final"] == list(finals[gid]), (s["id"], s["real"][-1]["score"], s["final"], finals[gid])
        assert abs(s["score"][0] - s["score"][1]) <= CLUTCH_MARGIN and s["clock"] <= CLUTCH_SECS and s["period"] >= 4
        assert s["me"] in (s["home"], s["away"])
    assert len(data["teams"]) == 30, len(data["teams"])
    assert len(data["schedule"]) == SCHEDULE_DAYS
    assert set(data["schedule"].values()) <= {s["id"] for s in data["spots"]}
    assert len({s["id"] for s in data["spots"]}) == len(data["spots"])
    assert len(data) == 6


def _walk_all(x, path="root"):
    if isinstance(x, dict):
        for k, v in x.items():
            yield from _walk_all(v, f"{path}.{k}")
    elif isinstance(x, list):
        for i, v in enumerate(x):
            yield from _walk_all(v, f"{path}[{i}]")
    else:
        yield path, x


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", default=RAW_DIR, help="directory with nbastats_<season>.tar.xz (default: data/raw/hoops, downloaded when missing)")
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args(argv)

    frames = [load_season(s, args.raw) for s in SEASONS]
    df = pd.concat(frames, ignore_index=True)
    print(f"loaded {len(df):,} rows")

    games: list[Game] = []
    index_in_season = {}  # game id -> its number in the season, by id order
    per_season = Counter()
    for (season, gid), rows in df.groupby(["season", "GAME_ID"], sort=True):
        per_season[season] += 1
        index_in_season[int(gid)] = per_season[season]
        games.append(Game(int(gid), int(season), rows.itertuples(index=False)))
    print(f"parsed {len(games)} games")

    check_assumptions(df, games)

    league = league_rates(games)
    counts = league.pop("_n")
    teams = team_profiles(games)
    cities = team_cities(df)
    for tm, t in teams.items():
        t["city"] = cities[tm]
    spots = []
    for g in games:
        s = game_spot(g, index_in_season[g.gid])
        if s:
            spots.append(s)
    spots.sort(key=lambda s: (s["season"], s["n"]))
    data = {
        "built": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "seasons": SEASONS,
        "league": league,
        "teams": teams,
        "spots": spots,
        "schedule": build_schedule(spots),
    }
    validate(data, games)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(data, f, separators=(",", ":"), ensure_ascii=False)

    # Summary.
    print("\n== summary ==")
    print(f"games {league['games']}  clutch possessions {league['possessions']}  spots {len(spots)}")
    print(f"sample sizes: {counts}")
    print("league:")
    for k, v in league.items():
        print(f"   {k:<14} {v}")
    real_len = [len(s["real"]) for s in spots]
    print(f"real log length: mean {mean(real_len):.1f} max {max(real_len)}  over {REAL_MAX}: {sum(l > REAL_MAX for l in real_len)}")
    print(f"spots by kind of clock: <=20 s {sum(s['clock'] <= 20 for s in spots)}, 20-120 s {sum(20 < s['clock'] <= 120 for s in spots)}; in overtime {sum(s['period'] > 4 for s in spots)}")
    print(f"spots with five players a side: {sum(len(s['players']['home']) == 5 and len(s['players']['away']) == 5 for s in spots)}")
    print(f"timeouts at the spot: {dict(Counter(tuple(s['timeouts']) for s in spots).most_common(6))}")
    for s in (spots[0], spots[len(spots) // 2], spots[-1]):
        print("example:", json.dumps(s, separators=(",", ":"), ensure_ascii=False)[:400])
    print(f"wrote {args.out} ({os.path.getsize(args.out) / 1e6:.1f} MB)")
    return data


if __name__ == "__main__":
    main()
