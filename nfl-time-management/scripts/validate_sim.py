"""Validate the simulator against real outcomes (2023-2025)."""
import json
import sys

from nflclock import config, data, validate

if __name__ == "__main__":
    n_states = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
    pbp = data.load(tuple(range(2016, 2027)))
    pbp = pbp[pbp["season"].isin(config.ANALYSIS_SEASONS)]
    drives, summary = validate.drive_replay(pbp, config.ANALYSIS_SEASONS, n_sims=600, max_drives=n_states // 3)
    print(summary.round(3).to_string())
    df, metrics = validate.late_game_calibration(pbp, config.ANALYSIS_SEASONS, n_states=n_states, n_sims=500)
    print(json.dumps(metrics, indent=1))
    config.REPORT_DIR.mkdir(exist_ok=True)
    summary.to_csv(config.REPORT_DIR / "validation_drives.csv", index=False)
    with open(config.REPORT_DIR / "validation_calibration.json", "w") as f:
        json.dump(metrics, f, indent=1)
    df[["game_id", "play_id", "game_seconds_remaining", "y_home", "sim_wp_home", "model_wp_home",
        "nflfastr_wp_home"]].to_csv(config.REPORT_DIR / "validation_states.csv", index=False)
