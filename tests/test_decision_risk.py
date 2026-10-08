from rh_meme_bot.config import RiskThresholds
from rh_meme_bot.decision import decide, load_decision_fn, normalize_decision, safe_decide
from rh_meme_bot.risk import apply_gates, score_risk


def test_stub_shape():
    out = decide({})
    assert out["action"] in ("buy", "hold", "skip")
    assert isinstance(out["confidence"], float)


def test_load_default_and_custom():
    assert load_decision_fn("") is decide
    fn = load_decision_fn("rh_meme_bot.decision:decide")
    assert fn is decide


def test_normalize_rejects_garbage():
    assert normalize_decision("buy")["action"] == "skip"
    assert normalize_decision({"action": "YOLO", "confidence": 1})["action"] == "skip"
    assert normalize_decision({"action": "BUY", "confidence": 3})["confidence"] == 1.0
    assert normalize_decision({"action": "buy", "confidence": "x"})["action"] == "skip"


def test_safe_decide_swallows_errors():
    def boom(_):
        raise RuntimeError("model down")
    assert safe_decide(boom, {})["action"] == "skip"


def _state(**kw):
    s = {
        "token": {"has_bytecode": True, "owner_status": "renounced",
                  "total_supply_raw": 10**27, "symbol": "M", "decimals": 18},
        "pool": {"liquidity": 10**18},
        "quote_reserve": 5.0,
        "price": 0.01,
    }
    s.update(kw)
    s["risk_score"], s["risk_flags"] = score_risk(s)
    return s


def test_risk_clean_token_is_zero():
    assert _state()["risk_score"] == 0.0


def test_risk_no_bytecode_is_max():
    st = _state(token={"has_bytecode": False})
    assert st["risk_score"] == 1.0
    assert "no_bytecode" in st["risk_flags"]


def test_gates():
    t = RiskThresholds(min_liquidity=1.0, min_confidence=0.7, max_risk_score=0.5)
    buy = {"action": "buy", "confidence": 0.9}
    assert apply_gates(buy, _state(), t) == ("buy", [])
    assert apply_gates({"action": "buy", "confidence": 0.5}, _state(), t)[0] == "skip"
    assert apply_gates(buy, _state(quote_reserve=0.1), t)[0] == "skip"
    assert apply_gates(buy, _state(quote_reserve=None), t)[0] == "skip"
    assert apply_gates(buy, _state(token={"has_bytecode": False}), t)[0] == "skip"
    assert apply_gates({"action": "hold", "confidence": 1.0}, _state(), t) == ("hold", [])
