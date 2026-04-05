# API Schema Snapshot

This directory contains a committed OpenAPI snapshot for the Argus FastAPI backend.

## Files

- `openapi.json` — Auto-generated schema from `argus.web.server:app`.

## Regenerate

From repository root:

```bash
python3 scripts/export-openapi.py
```

Re-run this whenever API routes, parameters, or response models change.
