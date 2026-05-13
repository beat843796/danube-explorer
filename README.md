# Danube Explorer

FastAPI app that serves a static map frontend and proxies the EuRIS `tracks/bounding-box` endpoint.

## Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Optional: create a `.env` file in the project root with your EuRIS token.

```
EURIS_TOKEN=your-token-here
```

Without a token, requests to EuRIS are sent unauthenticated.

## Run

```bash
uvicorn app:app --reload
```

Then open http://127.0.0.1:8000.

To bind a different host/port:

```bash
uvicorn app:app --host 0.0.0.0 --port 8080
```

## Endpoints

- `GET /` — static frontend (`static/index.html`)
- `GET /data/*` — static datasets in `data/`
- `GET /api/tracks` — EuRIS proxy. Query params: `minLat`, `maxLat`, `minLng`, `maxLng`, `pageSize` (1–1000, default 100), `maxPages` (1–50, default 5).
