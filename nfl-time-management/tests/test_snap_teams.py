import pandas as pd

from nflclock.players import fix_snap_teams


def test_swapped_snap_counts_are_put_back():
    """A game whose snap counts list each team's players under the other team's name (PFR's Super Bowl XLIX) is
    swapped back; a game listed right is left alone."""
    players = pd.DataFrame({"pfr_id": ["WilsRu00", "BradTo00", "RodgAa00"], "gsis_id": ["g-wilson", "g-brady", "g-rodgers"]})
    snaps = pd.DataFrame({"game_id": ["sb", "sb", "ok"], "team": ["SEA", "NE", "GB"], "opponent": ["NE", "SEA", "CHI"],
                          "pfr_player_id": ["BradTo00", "WilsRu00", "RodgAa00"], "offense_snaps": [74, 53, 60]})
    pbp = pd.DataFrame({"game_id": ["sb", "sb", "ok"], "posteam": ["NE", "SEA", "GB"],
                        "passer_player_id": ["g-brady", "g-wilson", "g-rodgers"], "rusher_player_id": [None] * 3,
                        "receiver_player_id": [None] * 3})
    out = fix_snap_teams(snaps, players, pbp)
    assert dict(zip(out["pfr_player_id"], out["team"])) == {"BradTo00": "NE", "WilsRu00": "SEA", "RodgAa00": "GB"}
    assert list(out["opponent"]) == ["SEA", "NE", "CHI"]
