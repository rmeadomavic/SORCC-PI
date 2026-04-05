from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

_CORS_ALLOWED_PATHS = {"/api/status"}


class InstructorCORSMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if request.url.path in _CORS_ALLOWED_PATHS:
            response.headers["Access-Control-Allow-Origin"] = "*"
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        return response
