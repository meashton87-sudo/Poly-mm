"""College pipeline: normalization to the nflverse schema, the clock reconstruction, the clock-quality filter and the
out-of-bounds inference, on small synthetic cfbfastR games."""
import numpy as np
import pandas as pd
import pytest

from nflclock.cfb import config as K
from nflclock.cfb import data as D


def play(gid, n, q, mm, ss, pos, dfn, ptype, text, down=1, dist=10, ytg_goal=75, yds=0, pos_sc=0, def_sc=0, to=(3, 3),
         drive=1, dnum=1, **kw):
    r = {"year": 2024, "week": 5, "season_type": "regular", "game_id": gid, "id_play": float(gid) * 1e9 + n,
         "game_play_number": n, "drive_number": drive, "drive_play_number": dnum, "pos_team": pos, "def_pos_team": dfn,
         "home": "Home U", "away": "Away St", "home_team_division": "fbs", "away_team_division": "fbs", "period": q,
         "clock_minutes": mm, "clock_seconds": ss, "play_type": ptype, "play_text": text, "down": down, "distance": dist,
         "yards_to_goal": ytg_goal, "yards_gained": yds, "EPA": 0.1, "wp_before": 0.5, "spread": -3.0,
         "pos_team_score": pos_sc, "def_pos_team_score": def_sc, "pos_team_timeouts_rem_before": to[0],
         "def_pos_team_timeouts_rem_before": to[1], "off_timeout_called": 0, "def_timeout_called": 0,
         "penalty_flag": False, "penalty_declined": False, "completion": 1 if ptype == "Pass Reception" else 0,
         "passer_player_name": None, "rusher_player_name": None, "receiver_player_name": None, "drive_result": "PUNT"}
    r.update(kw)
    return r


def game(gid=401, frozen=False):
    """Home U receives, drives, scores a touchdown (PAT good); Away St then plays late in the 4th quarter."""
    H, A = "Home U", "Away St"
    rows = [play(gid, 1, 1, 15, 0, H, A, "Kickoff", "kickoff for 65 yds for a touchback", ytg_goal=65),
            play(gid, 2, 1, 14, 52, H, A, "Rush", "J Back run for 4 yds", yds=4, ytg_goal=75, rusher_player_name="J Back"),
            play(gid, 3, 1, 14, 20, H, A, "Pass Incompletion", "Q Back pass incomplete to W Out", down=2, dist=6, ytg_goal=71),
            play(gid, 4, 1, 14, 15, H, A, "Pass Reception", "Q Back pass complete to W Out for 12 yds", down=3, dist=6, ytg_goal=71,
                 yds=12, passer_player_name="Q Back", receiver_player_name="W Out"),
            play(gid, 5, 1, 13, 40, H, A, "Rushing Touchdown", "J Back 59 Yd Run (K Leg Kick)", ytg_goal=59, yds=59, pos_sc=7)]
    t = [(4, 1, 50), (4, 1, 22), (4, 0, 58), (4, 0, 52), (4, 0, 41), (4, 0, 37)]
    plays = [("Pass Reception", 9, "Q2 pass complete to W2 for 9 yds"), ("Rush", 3, "R2 run for 3 yds"),
             ("Pass Reception", 6, "Q2 pass complete to W2 for 6 yds"), ("Rush", 5, "R2 run for 5 yds"),
             ("Pass Reception", 7, "Q2 pass complete to W2 for 7 yds, out of bounds"), ("Pass Incompletion", 0, "Q2 pass incomplete")]
    yl = 70
    for k, ((q, mm, ss), (pt, y, txt)) in enumerate(zip(t, plays)):
        if frozen:
            mm, ss = 1, 50
        rows.append(play(gid, 10 + k, q, mm, ss, A, H, pt, txt, ytg_goal=yl, yds=y, pos_sc=0, def_sc=7, drive=3, dnum=k + 1))
        yl -= y
    return pd.DataFrame(rows)


def test_normalize_schema_and_scores():
    n = D.normalize(game())
    for c in ("game_id", "posteam", "defteam", "yardline_100", "qtr", "quarter_seconds_remaining", "half_seconds_remaining",
              "game_seconds_remaining", "play_type", "epa", "wp", "spread_line", "posteam_timeouts_remaining", "result"):
        assert c in n
    assert n["spread_line"].iloc[0] == 3.0          # cfbfastR spread < 0 = home favoured; nflverse > 0
    td = n[n["touchdown"] == 1].iloc[0]
    assert td["posteam_score"] == 0 and td["td_team"] == "Home U"   # the score before the snap
    tr = n[n["extra_point_attempt"] == 1]
    assert len(tr) == 1 and tr.iloc[0]["extra_point_result"] == "good" and tr.iloc[0]["posteam_score"] == 6
    assert n.loc[n["play_type"] == "kickoff", "posteam"].iloc[0] == "Home U"   # kickoffs: posteam receives
    assert set(n["play_type"].dropna()) <= {"run", "pass", "kickoff", "extra_point", "qb_spike", "qb_kneel", "no_play",
                                            "punt", "field_goal"}


def test_snap_clock_from_end_of_play_times():
    n = D.normalize(game())
    r = n[n["desc"].str.startswith("J Back run")].iloc[0]
    # the feed's 14:52 is when the 4-yard run ended: the snap was the play's length (5 + 0.12 x 4 s) earlier,
    # but never before the previous play (the kickoff) ended at 15:00
    assert r["quarter_seconds_remaining"] == pytest.approx(min(892 + 5.48, 900))
    inc = n[n["desc"].str.startswith("Q Back pass incomplete")].iloc[0]
    assert inc["quarter_seconds_remaining"] == pytest.approx(860 + 5.0)


def test_spike_detected_only_where_the_feed_names_receivers():
    df = game()
    df.loc[df.index[-1], "play_text"] = "Q2 pass incomplete, Spike"
    n = D.normalize(df)
    assert (n["play_type"] == "qb_spike").sum() == 1


def test_clock_filter_flags_frozen_game():
    e = D.enrich(D.normalize(pd.concat([game(401), game(402, frozen=True)], ignore_index=True)))
    q = D.clock_quality(e)
    assert not q.loc["401", "clock_bad"]
    assert q.loc["402", "clock_bad"]


def test_oob_inference_on_synthetic_sequences():
    e = D.enrich(D.normalize(game()))
    o = D.infer_oob(e)
    late = e["qtr"].eq(4).to_numpy()
    # the catch the text calls out of bounds is out, whatever the clock says
    txt = e["desc"].str.contains("out of bounds").to_numpy()
    assert o.loc[txt, "oob"].all()
    # inside 2:00, a catch short of the line followed 4 s later by the next snap: the clock stopped
    k = e.index[e["desc"].str.contains("for 6 yds").to_numpy() & late][0]
    assert o.loc[k, "oob_src"] == "clock"
    assert bool(o.loc[k, "oob"]) == bool(o.loc[k, "oob_gap"] <= K.OOB_GAP)
    # a gain with the clock clearly running (20+ s to the next snap) is in bounds
    run = e.index[e["desc"].str.startswith("R2 run for 3").to_numpy()][0]
    assert o.loc[run, "oob_gap"] > K.INB_GAP and not o.loc[run, "oob"]


def test_oob_rates_from_explicit_games():
    cells = np.array([0, 0, 0, 1, 1])
    ex = np.array([True, True, True, True, False])
    text = np.array([True, False, False, True, True])
    r = D.oob_rates(cells, ex, text)
    assert r.shape == (D.N_CELLS,)
    assert 0 < r[0] < 1 and r[1] > r[0]      # cell 1: one explicit play, out of bounds


def test_fd_credit_and_report_run_without_nan():
    e = D.enrich(D.normalize(game()))
    e["oob_src"] = np.where(e["oob_src"] == "", "", "text")
    rep = D.oob_window(e)
    assert set(rep) >= {"oob_inside_2min", "inbounds_inside_2min"}
