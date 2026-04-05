from fastapi import APIRouter

from argus.web import app_state

router = APIRouter()


@router.get('/api/profiles')
async def list_profiles():
    return app_state.load_profiles().get('profiles', [])


@router.get('/api/profiles/active')
async def get_active_profile():
    profiles = app_state.load_profiles()
    for p in profiles.get('profiles', []):
        if p.get('id') == app_state.active_profile:
            return {'active': app_state.active_profile, 'profile': p}
    return {'active': app_state.active_profile, 'profile': None}


from fastapi import HTTPException, Request


@router.post('/api/profiles/switch')
async def switch_profile(request: Request):
    body = await request.json()
    profile_id = body.get('id')
    if not profile_id:
        raise HTTPException(status_code=400, detail="Missing 'id' in request body")
    profiles = app_state.load_profiles()
    target = next((p for p in profiles.get('profiles', []) if p.get('id') == profile_id), None)
    if not target:
        raise HTTPException(status_code=404, detail=f"Profile '{profile_id}' not found")
    app_state.active_profile = profile_id
    return {'status': 'ok', 'active': app_state.active_profile, 'profile': target}
