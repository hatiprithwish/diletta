"""Blocking: calls an async object's methods to completion, so a test reads as the calls it makes."""

import asyncio


class Blocking:
    def __init__(self, target: object) -> None:
        self._target = target

    def __getattr__(self, name: str) -> object:
        attribute = getattr(self._target, name)
        if not callable(attribute):
            return attribute
        return lambda *args, **kwargs: asyncio.run(attribute(*args, **kwargs))
