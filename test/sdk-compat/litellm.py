#!/usr/bin/env python3
"""LiteLLM compatibility smoke test (thin client; the Node runner owns the worker + mock).

`test/run-py.mjs` starts the worker and a mock upstream, seeds a proxy token, and exports
PROXY_WORKER_URL / PROXY_MOCK_URL / PROXY_TOKEN / PROXY_FAKE_OPENAI. This file just drives LiteLLM
at the worker and asserts the mock saw the real key swapped in (and the token nowhere).

Run it (also part of `nub run test`):  nub run test:py
"""

import json
import os
import sys
import urllib.request

# this file's dir (sys.path[0]) shadows `import litellm`; drop it
sys.path.pop(0)

import litellm

litellm.telemetry = False

W = os.environ["PROXY_WORKER_URL"]
M = os.environ["PROXY_MOCK_URL"]
TOKEN = os.environ["PROXY_TOKEN"]
REAL = os.environ["PROXY_FAKE_OPENAI"]


def captured():
    with urllib.request.urlopen(f"{M}/__captured") as r:
        return json.load(r)


def main():
    litellm.completion(
        model="openai/gpt-x",
        api_base=f"{W}/v1",
        api_key=TOKEN,
        messages=[{"role": "user", "content": "ping-from-litellm"}],
        max_tokens=5,
        timeout=20,
        num_retries=0,
    )
    cap = captured()
    h = cap["headers"]
    assert cap["path"] == "/v1/chat/completions", cap["path"]
    assert h.get("authorization") == f"Bearer {REAL}", h.get("authorization")
    assert TOKEN not in json.dumps(h), "proxy token leaked into upstream headers"
    assert "ping-from-litellm" in cap["body"], "request body not forwarded"
    print("PASS: litellm -> proxy swapped the real key, token never egressed, body forwarded verbatim")


if __name__ == "__main__":
    main()
