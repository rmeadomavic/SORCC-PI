from __future__ import annotations

import hmac

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from argus.web import app_state
from argus.web.middleware.auth import check_rate_limit, make_session_cookie, record_auth_failure, validate_session_cookie

router = APIRouter()


def bind_templates(templates: Jinja2Templates) -> None:
    global _templates
    _templates = templates


@router.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return _templates.TemplateResponse("base.html", {"request": request})


@router.get("/instructor", response_class=HTMLResponse)
async def instructor_page(request: Request):
    return _templates.TemplateResponse("instructor.html", {"request": request})


@router.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    if app_state.web_password is None:
        return RedirectResponse(url="/", status_code=302)
    cookie = request.cookies.get("argus_session", "")
    if cookie and validate_session_cookie(cookie):
        return RedirectResponse(url="/", status_code=302)
    return _templates.TemplateResponse("login.html", {"request": request, "error": request.query_params.get("error", "")})


@router.post("/api/login")
async def api_login(request: Request):
    if app_state.web_password is None:
        return {"status": "ok", "detail": "No password required"}
    client_ip = request.client.host if request.client else "unknown"
    if check_rate_limit(client_ip):
        raise HTTPException(status_code=429, detail="Too many attempts, try again later")
    try:
        body = await request.json()
        password = body.get("password", "")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid request body")

    if not password:
        raise HTTPException(status_code=401, detail="Password required")
    if hmac.compare_digest(password, app_state.web_password):
        response = JSONResponse(content={"status": "ok"})
        response.set_cookie("argus_session", make_session_cookie(), httponly=True, samesite="lax", path="/", max_age=app_state.session_timeout_sec)
        app_state.auth_failures.pop(client_ip, None)
        return response
    record_auth_failure(client_ip)
    raise HTTPException(status_code=401, detail="Wrong password")


@router.post("/api/logout")
async def api_logout():
    response = JSONResponse(content={"status": "ok"})
    response.delete_cookie(key="argus_session", path="/")
    return response
