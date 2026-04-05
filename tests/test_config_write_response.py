import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from argus.web import server


class _DummyRequest:
    def __init__(self, payload):
        self._payload = payload

    async def json(self):
        return self._payload


class ConfigWriteResponseTests(unittest.TestCase):
    def test_config_write_includes_restart_required_from_write_result(self):
        updates = {"general": {"hostname": "argus-node"}}
        validate_result = SimpleNamespace(errors=[], warnings=[])

        with patch.object(server, "_HAS_CONFIG_API", True), \
             patch.object(server, "write_config", return_value={"restart_required": ["wifi.country_code"], "skipped": []}), \
             patch.object(server.events, "log"), \
             patch.object(server, "configure_web_password"), \
             patch("argus.config_schema.validate", return_value=validate_result):
            result = asyncio.run(server.config_write(_DummyRequest(updates)))

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["restart_required"], ["wifi.country_code"])
        self.assertEqual(result["skipped"], [])

    def test_config_write_defaults_restart_required_to_empty_list(self):
        updates = {"general": {"hostname": "argus-node"}}
        validate_result = SimpleNamespace(errors=[], warnings=[])

        with patch.object(server, "_HAS_CONFIG_API", True), \
             patch.object(server, "write_config", return_value={"skipped": ["foo.bar (unknown field)"]}), \
             patch.object(server.events, "log"), \
             patch.object(server, "configure_web_password"), \
             patch("argus.config_schema.validate", return_value=validate_result):
            result = asyncio.run(server.config_write(_DummyRequest(updates)))

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["restart_required"], [])
        self.assertEqual(result["skipped"], ["foo.bar (unknown field)"])


if __name__ == "__main__":
    unittest.main()
