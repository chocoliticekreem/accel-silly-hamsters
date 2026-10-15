"""Helpers every pipeline step uses: cached fetches, citations, processed-file writes."""

from __future__ import annotations

from typing import Any

import httpx
from pydantic import BaseModel

from backend import cache, settings
from backend.contract import Source
from backend.store import now_iso, write_json

USER_AGENT = "smart-city-sim/0.1 (hackathon research prototype; small scoped requests)"
TIMEOUT = httpx.Timeout(60.0, connect=15.0)


class FetchError(RuntimeError):
    pass


def fetch(
    source: str,
    url: str,
    *,
    params: dict | None = None,
    method: str = "GET",
    data: dict | None = None,
    headers: dict | None = None,
    as_json: bool = True,
    timeout: httpx.Timeout | None = None,
) -> tuple[Any, str]:
    """GET/POST through the scrape cache (data/raw/{source}/). Returns (body, fetchedAt).

    Never re-fetches what is on disk unless the cache policy says refresh. Raises FetchError on
    network/HTTP failure so the caller can fall back to its defaults.
    """
    key_params = {"params": params or {}, "data": data, "method": method}
    cached = cache.scrape_get(source, url, key_params)
    if cached is not None:
        return cached["content"], cached["fetchedAt"]
    try:
        response = httpx.request(
            method,
            url,
            params=params,
            data=data,
            headers={"User-Agent": USER_AGENT, **(headers or {})},
            timeout=timeout or TIMEOUT,
            follow_redirects=True,
        )
        response.raise_for_status()
    except httpx.HTTPError as e:
        raise FetchError(f"{source}: {method} {url} failed: {e}") from e
    body = response.json() if as_json else response.text
    fetched_at = now_iso()
    cache.scrape_put(
        source, url, key_params, {"content": body, "fetchedAt": fetched_at}, fetched_at
    )
    return body, fetched_at


def cite(label: str, url: str, fetched_at: str | None = None) -> Source:
    return Source(label=label, url=url, fetchedAt=fetched_at)


def write_processed(name: str, model: BaseModel) -> None:
    write_json(settings.PROCESSED_DIR / name, model)
