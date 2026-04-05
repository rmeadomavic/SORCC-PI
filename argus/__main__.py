"""Argus Dashboard — entry point."""
import os
import uvicorn

from argus.config_api import get_config_path, set_config_path

if __name__ == "__main__":
    env_config_path = os.environ.get("ARGUS_CONFIG_PATH", "").strip()
    if env_config_path:
        set_config_path(env_config_path)

    kwargs = {
        "host": "0.0.0.0",
        "port": 8080,
        "workers": 1,  # single worker — event logger hash chain requires single-process writes
        "log_level": "warning",
    }

    # TLS: enable with ARGUS_TLS=1 env var or tls_enabled in config
    tls_enabled = os.environ.get("ARGUS_TLS", "").strip() == "1"
    if not tls_enabled:
        try:
            import configparser
            cfg = configparser.ConfigParser()
            cfg.read(get_config_path())
            tls_enabled = cfg.get("dashboard", "tls_enabled", fallback="false").lower() == "true"
        except Exception:
            pass

    if tls_enabled:
        try:
            from argus.tls import ensure_tls_cert
            cert, key = ensure_tls_cert()
            kwargs["ssl_certfile"] = cert
            kwargs["ssl_keyfile"] = key
            kwargs["port"] = int(os.environ.get("ARGUS_PORT", "8443"))
            print(f"[Argus] TLS enabled — https://0.0.0.0:{kwargs['port']}")
        except Exception as e:
            print(f"[Argus] TLS setup failed, falling back to HTTP: {e}")

    uvicorn.run("argus.web.server:app", **kwargs)
