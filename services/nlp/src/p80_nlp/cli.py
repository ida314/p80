"""Entry point for the sidecar.

Binds `127.0.0.1` by default (spec §32.5, `CLAUDE.md` rule 13). The host and port come
from the same `P80_*` variables the TypeScript processes read, so there is one place to
change them and no chance of the API's `P80_NLP_BASE_URL` pointing somewhere this
process is not.
"""

from __future__ import annotations

import os

import uvicorn


def main() -> None:
    host = os.environ.get("P80_BIND_HOST", "127.0.0.1")
    port = int(os.environ.get("P80_NLP_PORT", "5181"))
    log_level = os.environ.get("P80_LOG_LEVEL", "info")
    if log_level == "silent":
        log_level = "critical"

    uvicorn.run(
        "p80_nlp.main:app",
        host=host,
        port=port,
        log_level=log_level,
    )


if __name__ == "__main__":
    main()
