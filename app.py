import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")

EURIS_TOKEN = os.environ.get("EURIS_TOKEN", "").strip()
EURIS_BASE = "https://www.eurisportal.eu/api/v3"

logger = logging.getLogger("uvicorn.error")

http_client: httpx.AsyncClient | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global http_client
    http_client = httpx.AsyncClient(timeout=20.0)
    try:
        yield
    finally:
        await http_client.aclose()
        http_client = None


app = FastAPI(title="Danube Explorer", lifespan=lifespan)


@app.get("/api/tracks")
async def get_tracks(
    minLat: float = Query(...),
    maxLat: float = Query(...),
    minLng: float = Query(...),
    maxLng: float = Query(...),
    pageSize: int = Query(100, ge=1, le=1000),
    maxPages: int = Query(5, ge=1, le=50),
    rectIndex: int | None = Query(None),
):
    headers = {"Accept": "application/json"}
    if EURIS_TOKEN:
        headers["Authorization"] = f"Bearer {EURIS_TOKEN}"

    assert http_client is not None
    all_tracks: list[dict] = []
    skip = 0
    for _ in range(maxPages):
        params = {
            "minLat": minLat,
            "maxLat": maxLat,
            "minLon": minLng,
            "maxLon": maxLng,
            "pageSize": pageSize,
            "skip": skip,
        }
        r = await http_client.get(
            f"{EURIS_BASE}/tracks/bounding-box",
            params=params,
            headers=headers,
        )
        if r.status_code != 200:
            logger.warning("EuRIS %s -> %s: %s", params, r.status_code, r.text[:300])
            raise HTTPException(status_code=r.status_code, detail=r.text)
        page = r.json()
        if not isinstance(page, list):
            raise HTTPException(
                status_code=502, detail="EuRIS returned non-list response"
            )
        all_tracks.extend(page)
        if len(page) < pageSize:
            break
        skip += pageSize
    rect_label = f"rect{rectIndex}" if rectIndex is not None else "bbox"
    logger.info("EuRIS: returned %d tracks for %s", len(all_tracks), rect_label)
    return all_tracks


app.mount("/data", StaticFiles(directory=ROOT / "data"), name="data")
app.mount("/", StaticFiles(directory=ROOT / "static", html=True), name="static")
