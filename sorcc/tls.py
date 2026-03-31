"""SORCC-PI — Auto-generate self-signed TLS certificate for HTTPS.

Usage:
    from sorcc.tls import ensure_tls_cert
    cert, key = ensure_tls_cert()
    # Pass to uvicorn: ssl_certfile=cert, ssl_keyfile=key

Generates once, persists, reuses. Controlled by [dashboard] tls_enabled in config.
"""

import logging
import subprocess
from pathlib import Path

log = logging.getLogger(__name__)

DEFAULT_CERT_DIR = "/opt/sorcc/config"
CERT_FILE = "sorcc-tls.crt"
KEY_FILE = "sorcc-tls.key"


def ensure_tls_cert(
    cert_dir: str = DEFAULT_CERT_DIR,
    org: str = "SORCC",
    cn: str = "sorcc-dashboard",
) -> tuple[str, str]:
    """Ensure a self-signed TLS cert exists, generating one if needed.

    Returns (cert_path, key_path).
    """
    cert_path = Path(cert_dir) / CERT_FILE
    key_path = Path(cert_dir) / KEY_FILE

    if cert_path.exists() and key_path.exists():
        log.info("TLS cert exists: %s", cert_path)
        return str(cert_path), str(key_path)

    log.info("Generating self-signed TLS certificate...")
    Path(cert_dir).mkdir(parents=True, exist_ok=True)

    try:
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048",
            "-keyout", str(key_path), "-out", str(cert_path),
            "-days", "3650", "-nodes",
            "-subj", f"/O={org}/CN={cn}",
        ], check=True, capture_output=True, timeout=30)
        log.info("TLS cert generated: %s", cert_path)
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        log.error("Failed to generate TLS cert: %s", e)
        raise RuntimeError(f"TLS cert generation failed: {e}") from e

    return str(cert_path), str(key_path)
