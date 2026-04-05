import asyncio

from argus.web.routers import devices


def test_devices_route_list(monkeypatch):
    monkeypatch.setattr(devices, 'get_devices_data', lambda: [{"mac": "aa", "activity": 0, "packets": 1}])
    resp = asyncio.run(devices.get_devices())
    assert isinstance(resp, list)
    assert resp[0]['mac'] == 'aa'
