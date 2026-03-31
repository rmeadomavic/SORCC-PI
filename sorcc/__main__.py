"""SORCC-PI Dashboard — entry point."""
import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "sorcc.web.server:app",
        host="0.0.0.0",
        port=8080,
        workers=2,
        log_level="warning",
    )
