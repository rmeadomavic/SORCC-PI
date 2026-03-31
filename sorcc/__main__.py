"""SORCC-PI Dashboard — entry point."""
import os
import uvicorn

if __name__ == "__main__":
    kwargs = {
        "host": "0.0.0.0",
        "port": 8080,
        "workers": 1,  # single worker — event logger hash chain requires single-process writes
        "log_level": "warning",
    }

    # TLS: enable with SORCC_TLS=1 env var or tls_enabled in config
    tls_enabled = os.environ.get("SORCC_TLS", "").strip() == "1"
    if not tls_enabled:
        try:
            import configparser
            cfg = configparser.ConfigParser()
            cfg.read("/opt/sorcc/config/sorcc.ini")
            tls_enabled = cfg.get("dashboard", "tls_enabled", fallback="false").lower() == "true"
        except Exception:
            pass

    if tls_enabled:
        try:
            from sorcc.tls import ensure_tls_cert
            cert, key = ensure_tls_cert()
            kwargs["ssl_certfile"] = cert
            kwargs["ssl_keyfile"] = key
            kwargs["port"] = int(os.environ.get("SORCC_PORT", "8443"))
            print(f"[SORCC] TLS enabled — https://0.0.0.0:{kwargs['port']}")
        except Exception as e:
            print(f"[SORCC] TLS setup failed, falling back to HTTP: {e}")

    uvicorn.run("sorcc.web.server:app", **kwargs)
