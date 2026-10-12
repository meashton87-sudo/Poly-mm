import numpy as np
import pandas as pd

from nflclock import analyze, report
from nflclock.sim import KICKOFF, PAT


def _row(**kw):
    base = dict(posteam="KC", defteam="BUF", game_seconds_remaining=150.0, down=2.0, ydstogo=6.0, yardline_100=40.0,
                posteam_score=20, defteam_score=17, posteam_timeouts_remaining=2, defteam_timeouts_remaining=3,
                to_after_team=np.nan, t_end=145.0, next_yardline_100=36.0, n_down=3.0, n_ydstogo=2.0,
                n_posteam_score=20, n_defteam_score=17, n_posteam_timeouts_remaining=2,
                n_defteam_timeouts_remaining=2)
    base.update(kw)
    return base


def test_post_play_root_restores_the_timeout_being_graded():
    # BUF (defense, away) called a timeout after the play: the next snap shows 2 left, the decision had 3.
    r = _row(to_after_team="BUF")
    root = analyze._root_post_play(r, home="KC")
    assert root.pos == 0 and root.score == (20, 17)
    assert root.to == (2, 3)
    assert root.clock_running and root.t == 145.0
    assert (root.down, root.ytg, root.yl) == (3, 2.0, 36.0)


def test_post_play_root_away_offense():
    r = _row(to_after_team=np.nan, n_defteam_timeouts_remaining=3)
    root = analyze._root_post_play(r, home="BUF")  # KC is the away offense
    assert root.pos == 1
    assert root.score == (17, 20)
    assert root.to == (3, 2)


def test_special_phase_roots():
    pat = analyze._root_snap(_row(down=np.nan, ydstogo=np.nan), home="KC", phase=PAT)
    assert pat.phase == PAT and pat.pos == 0
    # kickoff rows list the receiving team as posteam; the kicking team decides
    ko = analyze._root_snap(_row(down=np.nan), home="KC", phase=KICKOFF, pos_team="BUF")
    assert ko.phase == KICKOFF and ko.pos == 1


def test_emergency_kicker_detected():
    rows = []
    # NYG's punter (P1) kicks a PAT; NYG's regular punting happens too. DAL is normal.
    rows.append(dict(game_id="g1", posteam="NYG", play_type="punt", punter_player_id="P1", kicker_player_id=None,
                     extra_point_attempt=0, field_goal_attempt=0, two_point_attempt=0, qtr=1))
    rows.append(dict(game_id="g1", posteam="NYG", play_type="punt", punter_player_id="P1", kicker_player_id=None,
                     extra_point_attempt=0, field_goal_attempt=0, two_point_attempt=0, qtr=3))
    rows.append(dict(game_id="g1", posteam="NYG", play_type="extra_point", punter_player_id=None, kicker_player_id="P1",
                     extra_point_attempt=1, field_goal_attempt=0, two_point_attempt=0, qtr=2))
    rows.append(dict(game_id="g1", posteam="DAL", play_type="extra_point", punter_player_id=None, kicker_player_id="K9",
                     extra_point_attempt=1, field_goal_attempt=0, two_point_attempt=0, qtr=2))
    rows.append(dict(game_id="g1", posteam="DAL", play_type="punt", punter_player_id="P9", kicker_player_id=None,
                     extra_point_attempt=0, field_goal_attempt=0, two_point_attempt=0, qtr=3))
    assert analyze.kicker_unavailable(pd.DataFrame(rows)) == {("g1", "NYG")}


def test_situation_text():
    r = pd.Series(dict(qtr=4, game_seconds_remaining=95, team="KC", posteam="KC", margin_off=-3, decision="fourth_down",
                       down=4.0, ydstogo=3.0, yardline_100=35.0))
    assert report._situation(r) == "Q4 1:35, down 3, 4&3 at opp 35"
    r2 = r.copy()
    r2["team"], r2["decision"] = "BUF", "def_timeout"
    assert report._situation(r2) == "Q4 1:35, up 3, 4&3 at opp 35 (opponent ball)"
