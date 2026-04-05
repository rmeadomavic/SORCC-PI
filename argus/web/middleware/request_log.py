import logging
import time

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

log = logging.getLogger(__name__)


class RequestLogMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path.startswith("/static"):
            return await call_next(request)
        t0 = time.time()
        try:
            response = await call_next(request)
            dt = (time.time() - t0) * 1000
            lvl = logging.WARNING if response.status_code >= 400 else logging.INFO
            log.log(lvl, "%s %s → %s (%.0fms)", request.method, request.url.path, response.status_code, dt)
            return response
        except Exception as exc:
            dt = (time.time() - t0) * 1000
            log.error("%s %s → 500 (%.0fms) %s: %s", request.method, request.url.path, dt, type(exc).__name__, exc)
            return JSONResponse(status_code=500, content={"detail": "Internal server error"})
