"""An httpx transport that sends the harness's backend calls over the BACKEND service binding (EvalRunnerEntrypoint's
fetch) instead of the internet. A Workers Free invocation may make 50 subrequests to the internet but 1,000 to
Cloudflare services, and every attempt makes several backend calls; only the host's own calls (the test user's sign-in,
read-backs) are left on the internet budget. The URL's host is ignored by a binding: the path is what the backend
routes, so EvalApiClient builds its URLs as it always does.
"""

from typing import Any

import httpx

# DEV_NOTE: Set by the binding's fetch itself (from the body and URL), never forwarded
_HOP_HEADERS = frozenset({"host", "content-length", "connection", "transfer-encoding"})


class BindingTransport(httpx.AsyncBaseTransport):
    def __init__(self, binding: Any) -> None:
        self._binding = binding

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        body = await request.aread()
        try:
            answer = await self._binding.fetch(
                str(request.url),
                method=request.method,
                headers={name: value for name, value in request.headers.items() if name not in _HOP_HEADERS},
                body=body.decode() if body else None,
            )
            content = await answer.bytes()
        except Exception as error:
            # DEV_NOTE: The harness reads an httpx error as "the backend is unreachable", as it does for the internet
            raise httpx.ConnectError(f"The backend binding failed: {type(error).__name__}", request=request) from error
        return httpx.Response(answer.status, content=content, request=request)
