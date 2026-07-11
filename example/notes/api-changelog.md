# API Changelog

## v1.4.0 — 2026-07-02

- Added `GET /v1/reports/:id/export` (CSV and Parquet).
- Rate limits now return `Retry-After`.
- **Breaking**: `POST /v1/queries` rejects unknown properties.

## v1.3.2 — 2026-06-14

- Fixed a pagination cursor leak on `/v1/events`.
- Python SDK:

```python
import atlas

client = atlas.Client()
for event in client.events.iterate(since="2026-06-01"):
    print(event.id, event.kind)
```

## v1.3.1 — 2026-06-02

- TLS 1.2 deprecated; 1.3 required from September.
