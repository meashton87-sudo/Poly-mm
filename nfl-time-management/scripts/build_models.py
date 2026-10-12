"""Fit every model and save the bundle to artifacts/bundle.pkl."""
from nflclock.models import build

if __name__ == "__main__":
    b = build()
    b.save()
    print("saved bundle; consts:", b.consts)
