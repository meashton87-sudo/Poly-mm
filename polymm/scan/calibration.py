"""Historical calibration: how often did contracts bought at price P actually win?

Built from Jon Becker's prediction-market-analysis dataset
(https://github.com/Jon-Becker/prediction-market-analysis), the largest public
archive of resolved Kalshi and Polymarket trades. The win-rate-by-price queries
mirror that repo's `win_rate_by_price` / `polymarket_calibration_by_bucket`
analyses. The result is a small `calibration.json` (a few hundred KB) that the
scanner loads to flag contracts priced below their historical hit rate (the
favourite-longshot bias and its relatives).

Build it once (needs `pip install duckdb zstandard`):

    python -m polymm.scan.calibrate --archive data.tar.zst      # downloaded archive
    python -m polymm.scan.calibrate --archive https://s3.jbecker.dev/data.tar.zst
    python -m polymm.scan.calibrate --data path/to/prediction-market-analysis/data

The archive is streamed: each parquet file is aggregated and deleted, so you
never need the ~36 GB extracted on disk.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .categories import kalshi_group, polymarket_group

ALL = "*"
# A member path inside the dataset: <...>/{kalshi,polymarket}/{markets,trades}/<file>.parquet
_MEMBER = re.compile(r"(?:^|/)(kalshi|polymarket)/(markets|trades)/[^/]+\.parquet$")


# ---------------------------------------------------------------------- lookup

@dataclass
class WinRate:
    p: float  # smoothed historical win probability
    n: int  # past markets behind it (each market counted once per price)
    se: float  # standard error of p
    group: str  # category the estimate came from ("*" = all markets)


class Calibration:
    """Win probability lookup with pooling and shrinkage.

    Counts are *markets*, not trades: one market's dozens of trades share a
    single outcome, so counting trades fakes precision (the backtest showed
    exactly that: estimates chasing noise). Neighbouring cents are pooled
    (+/- `window`) for the estimate, the raw win rate is shrunk toward the
    price with a Beta prior worth `prior_markets` markets, and the standard
    error uses the largest single bucket (a market trading at 29, 30 and 31c
    sits in all three) so pooling can't inflate confidence.
    """

    def __init__(self, data: dict, window: int = 1, prior_markets: float = 100.0, min_markets: int = 300):
        self.data = data
        self.tables: dict = data.get("tables", {})
        self.window = window
        self.prior = prior_markets
        self.min_markets = min_markets

    @classmethod
    def load(cls, path: str | Path, **kw) -> "Calibration":
        return cls(json.loads(Path(path).read_text()), **kw)

    @property
    def total_trades(self) -> int:
        return int(self.data.get("total_positions", 0))

    def _table(self, venue: str) -> dict | None:
        roles = self.tables.get(venue) or {}
        # We buy at the ask, i.e. as takers: use taker outcomes where we have them.
        return roles.get("taker") or roles.get("all")

    def win_prob(self, venue: str, side: str, price: float, group: str = ALL) -> WinRate | None:
        table = self._table(venue)
        if not table:
            return None
        cents = int(round(price * 100))
        if not 1 <= cents <= 99:
            return None
        for g in ((group, ALL) if group and group != ALL else (ALL,)):
            buckets = table.get(f"{g}|{side.lower()}")
            if not buckets:
                continue
            n = wins = n_max = 0
            for c in range(cents - self.window, cents + self.window + 1):
                nb, wb = buckets.get(str(c), (0, 0))
                n, wins, n_max = n + nb, wins + wb, max(n_max, nb)
            if n_max < self.min_markets:
                continue
            p = (wins + self.prior * price) / (n + self.prior)
            return WinRate(p, n_max, math.sqrt(p * (1 - p) / (n_max + self.prior)), g)
        return None


# ---------------------------------------------------------------------- build

class Builder:
    """Incrementally aggregates dataset parquet files into a calibration table.

    Files can arrive in any order (a tar stream isn't sorted): trades are
    pre-aggregated per market/side/price and joined to results at the end.
    """

    def __init__(self, db_path: str = ":memory:"):
        import duckdb  # optional dependency

        self.con = duckdb.connect(db_path)
        self.con.execute("""
            CREATE TABLE IF NOT EXISTS k_markets (ticker VARCHAR, event_ticker VARCHAR, result VARCHAR);
            CREATE TABLE IF NOT EXISTS k_trades (ticker VARCHAR, taker_side VARCHAR, yes_price INT, no_price INT, n BIGINT);
            CREATE TABLE IF NOT EXISTS p_markets (id VARCHAR, question VARCHAR, clob_token_ids VARCHAR, outcome_prices VARCHAR);
            CREATE TABLE IF NOT EXISTS p_trades (token_id VARCHAR, price INT, n BIGINT);
        """)
        self.files = {"kalshi/markets": 0, "kalshi/trades": 0, "polymarket/markets": 0, "polymarket/trades": 0}

    @staticmethod
    def classify(member: str) -> str | None:
        m = _MEMBER.search(member.replace("\\", "/"))
        return f"{m.group(1)}/{m.group(2)}" if m else None

    def add_file(self, kind: str, path: str) -> None:
        f = str(path).replace("'", "''")
        src = f"read_parquet('{f}', union_by_name=true)"
        if kind == "kalshi/markets":
            self.con.execute(f"""
                INSERT INTO k_markets
                SELECT DISTINCT ticker, event_ticker, result FROM {src}
                WHERE status = 'finalized' AND result IN ('yes', 'no')""")
        elif kind == "kalshi/trades":
            self.con.execute(f"""
                INSERT INTO k_trades
                SELECT ticker, taker_side, yes_price, no_price, COUNT(*) FROM {src}
                WHERE taker_side IN ('yes', 'no') GROUP BY ALL""")
        elif kind == "polymarket/markets":
            self.con.execute(f"""
                INSERT INTO p_markets
                SELECT CAST(id AS VARCHAR), CAST(question AS VARCHAR), CAST(clob_token_ids AS VARCHAR),
                       CAST(outcome_prices AS VARCHAR)
                FROM {src} WHERE closed""")
        elif kind == "polymarket/trades":
            # Buyer-of-token position: token and price in cents (USDC per token).
            self.con.execute(f"""
                INSERT INTO p_trades
                SELECT token_id, price, COUNT(*) FROM (
                    SELECT
                        CASE WHEN CAST(maker_asset_id AS VARCHAR) = '0' THEN CAST(taker_asset_id AS VARCHAR)
                             ELSE CAST(maker_asset_id AS VARCHAR) END AS token_id,
                        CAST(ROUND(CASE WHEN CAST(maker_asset_id AS VARCHAR) = '0'
                             THEN 100.0 * CAST(maker_amount AS DOUBLE) / CAST(taker_amount AS DOUBLE)
                             ELSE 100.0 * CAST(taker_amount AS DOUBLE) / CAST(maker_amount AS DOUBLE) END) AS INT) AS price
                    FROM {src}
                    WHERE CAST(maker_amount AS DOUBLE) > 0 AND CAST(taker_amount AS DOUBLE) > 0
                ) WHERE price BETWEEN 1 AND 99 GROUP BY ALL""")
        else:
            return
        self.files[kind] += 1

    # -- final join ----------------------------------------------------------

    def _kalshi(self) -> dict:
        # One row per (market, side, price) that was ever bought: n counts markets.
        rows = self.con.execute("""
            WITH m AS (SELECT DISTINCT ticker, event_ticker, result FROM k_markets),
            t AS (SELECT DISTINCT ticker, taker_side, yes_price, no_price FROM k_trades),
            taker AS (
                SELECT m.ticker, m.event_ticker, t.taker_side AS side,
                       CASE WHEN t.taker_side = 'yes' THEN t.yes_price ELSE t.no_price END AS price,
                       (t.taker_side = m.result) AS won
                FROM t JOIN m USING (ticker)),
            maker AS (
                SELECT m.ticker, m.event_ticker, CASE WHEN t.taker_side = 'yes' THEN 'no' ELSE 'yes' END,
                       CASE WHEN t.taker_side = 'yes' THEN t.no_price ELSE t.yes_price END,
                       (t.taker_side != m.result)
                FROM t JOIN m USING (ticker)),
            allp AS (SELECT DISTINCT * FROM (SELECT * FROM taker UNION ALL SELECT * FROM maker))
            SELECT regexp_extract(event_ticker, '^([A-Z0-9]+)', 1) AS cat, 'taker' AS role, side, price,
                   COUNT(*) AS n, SUM(CASE WHEN won THEN 1 ELSE 0 END) AS wins
            FROM taker WHERE price BETWEEN 1 AND 99 GROUP BY ALL
            UNION ALL
            SELECT regexp_extract(event_ticker, '^([A-Z0-9]+)', 1), 'all', side, price,
                   COUNT(*), SUM(CASE WHEN won THEN 1 ELSE 0 END)
            FROM allp WHERE price BETWEEN 1 AND 99 GROUP BY ALL""").fetchall()
        out: dict = {"taker": {}, "all": {}}
        group_of: dict[str, str] = {}
        for cat, role, side, price, n, wins in rows:
            g = group_of.setdefault(cat, kalshi_group(cat))
            for gg in (g, ALL):
                _bump(out[role], f"{gg}|{side}", price, n, wins)
        return out

    def _polymarket(self) -> dict:
        # Resolve tokens in Python (outcome prices are JSON strings), as upstream does.
        res = []
        for _id, question, tokens, prices in self.con.execute("SELECT * FROM p_markets").fetchall():
            try:
                p = [float(x) for x in json.loads(prices or "[]")]
                toks = [str(t) for t in json.loads(tokens or "[]")]
            except (ValueError, TypeError):
                continue
            if len(p) != 2 or len(toks) != 2:
                continue
            if p[0] > 0.99 and p[1] < 0.01:
                win = 0
            elif p[0] < 0.01 and p[1] > 0.99:
                win = 1
            else:
                continue
            g = polymarket_group(question or "")
            res += [(toks[0], str(_id), win == 0, "yes", g), (toks[1], str(_id), win == 1, "no", g)]
        self.con.execute("CREATE OR REPLACE TABLE p_res (token_id VARCHAR, market VARCHAR, won BOOLEAN, "
                         "side VARCHAR, grp VARCHAR)")
        if res:
            self.con.executemany("INSERT INTO p_res VALUES (?, ?, ?, ?, ?)", res)
        # One row per (market, side, price) traded: n counts markets, not fills.
        rows = self.con.execute("""
            WITH t AS (SELECT DISTINCT token_id, price FROM p_trades),
            pos AS (SELECT DISTINCT * FROM (
                SELECT r.market, r.grp, r.side, t.price, r.won FROM t JOIN p_res r USING (token_id)
                UNION ALL  -- the other side of every fill: the complement at 100 - price
                SELECT r.market, r.grp, CASE WHEN r.side = 'yes' THEN 'no' ELSE 'yes' END, 100 - t.price, NOT r.won
                FROM t JOIN p_res r USING (token_id)))
            SELECT grp, side, price, COUNT(*), SUM(CASE WHEN won THEN 1 ELSE 0 END)
            FROM pos GROUP BY ALL""").fetchall()
        out: dict = {"all": {}}
        for g, side, price, n, wins in rows:
            for gg in (g, ALL):
                _bump(out["all"], f"{gg}|{side}", price, n, wins)
        return out

    def finish(self, source: str) -> dict:
        tables = {}
        if self.files["kalshi/markets"] and self.files["kalshi/trades"]:
            tables["kalshi"] = self._kalshi()
        if self.files["polymarket/markets"] and self.files["polymarket/trades"]:
            tables["polymarket"] = self._polymarket()
        total = sum(n for v in tables.values() for role, t in v.items() if role == "all"
                    for k, b in t.items() if k.startswith(f"{ALL}|") for n, _ in b.values())
        return {
            "version": 2,  # v2: counts are distinct markets per price, not trades "source": source, "built": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "files": self.files, "total_positions": total, "tables": tables,
        }


def _bump(table: dict, key: str, price: int, n: int, wins: int) -> None:
    b = table.setdefault(key, {})
    cur = b.get(str(int(price)), [0, 0])
    b[str(int(price))] = [cur[0] + int(n), cur[1] + int(wins)]


def build_from_dir(data_dir: str | Path, log=print) -> dict:
    b = Builder()
    for kind, path in iter_dir(data_dir):
        b.add_file(kind, path)
    log(f"aggregated {b.files}")
    return b.finish(str(data_dir))


def iter_archive(source: str, workdir: str | Path, log=print, kinds: set[str] | None = None):
    """Stream a data.tar.zst (local path or https URL) and yield (kind, parquet_path)
    for each dataset file of interest. Each file is deleted once the caller moves
    on, so the ~36 GB archive never has to be unpacked on disk."""
    import tarfile
    import tempfile

    import zstandard

    from .sources import urlopen

    raw = urlopen(source, timeout=60) if source.startswith("http") else open(source, "rb")
    total = int(getattr(raw, "headers", {}).get("Content-Length", 0) or 0) if source.startswith("http") \
        else Path(source).stat().st_size

    class Counting:
        def __init__(self, f):
            self.f, self.n, self.next_report = f, 0, 0

        def read(self, size=-1):
            chunk = self.f.read(size)
            self.n += len(chunk)
            if self.n >= self.next_report:
                pct = f" ({100 * self.n / total:.1f}%)" if total else ""
                log(f"  read {self.n / 2**30:.2f} GiB{pct}")
                self.next_report = self.n + 2**30
            return chunk

    tmp = Path(tempfile.mkdtemp(dir=workdir))
    try:
        reader = zstandard.ZstdDecompressor(max_window_size=2**31).stream_reader(Counting(raw))
        with tarfile.open(fileobj=reader, mode="r|") as tar:
            for member in tar:
                kind = Builder.classify(member.name) if member.isfile() else None
                if not kind or (kinds is not None and kind not in kinds):
                    continue  # tar streams skip unread member data on their own
                part = tmp / "part.parquet"
                with tar.extractfile(member) as src, open(part, "wb") as dst:
                    while chunk := src.read(1 << 20):
                        dst.write(chunk)
                yield kind, str(part)
                part.unlink()
    finally:
        raw.close()
        for p in tmp.glob("*"):
            p.unlink()
        tmp.rmdir()


def iter_dir(data_dir: str | Path, kinds: set[str] | None = None):
    for path in sorted(Path(data_dir).rglob("*.parquet")):
        kind = Builder.classify(str(path))
        if kind and (kinds is None or kind in kinds):
            yield kind, str(path)


def build_from_archive(source: str, workdir: str | Path, log=print) -> dict:
    """Stream a data.tar.zst (local path or https URL), aggregating as it goes."""
    b = Builder()
    for kind, path in iter_archive(source, workdir, log):
        b.add_file(kind, path)
    log(f"aggregated {b.files}")
    return b.finish(source)
