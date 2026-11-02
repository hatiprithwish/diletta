"""Percentiles of the durations the harness measures itself (the same nearest-rank rule as packages/schemas
summarizeDurations, so a number here and one the backend reports mean the same thing)."""

import math
from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class Durations:
    count: int
    p50_ms: float
    p95_ms: float
    max_ms: float


def percentile(sorted_ascending: Sequence[float], q: float) -> float:
    """The smallest sample that at least q (0..1) of the samples are at or below; 0 for no samples."""
    if not sorted_ascending:
        return 0.0
    rank = min(len(sorted_ascending), max(1, math.ceil(q * len(sorted_ascending))))
    return sorted_ascending[rank - 1]


def summarize(samples: Sequence[float]) -> Durations:
    ordered = sorted(samples)
    return Durations(
        count=len(ordered),
        p50_ms=percentile(ordered, 0.5),
        p95_ms=percentile(ordered, 0.95),
        max_ms=ordered[-1] if ordered else 0.0,
    )
