import asyncio

from argus.web.routers import status


def test_status_route_shape(monkeypatch):
    async def fake_status():
        return {"kismet": True, "active_profile": "wifi-survey"}

    monkeypatch.setattr(status, 'get_status_data', fake_status)
    resp = asyncio.run(status.get_status())
    assert resp['active_profile'] == 'wifi-survey'
