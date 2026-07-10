#!/usr/bin/env python3
"""Exercise Instructor's OpenAI wrapper; verify its expected parse failure via mock capture."""

import json
import logging
import os
import sys
import urllib.request

# this file's dir (sys.path[0]) shadows `import instructor`; drop it
sys.path.pop(0)

import instructor
import openai
from instructor import Mode
from pydantic import BaseModel

# mute the retry-exhausted warning from the expected parse failure
logging.getLogger("instructor").setLevel(logging.CRITICAL)

W = os.environ["PROXY_WORKER_URL"]
M = os.environ["PROXY_MOCK_URL"]
TOKEN = os.environ["PROXY_TOKEN"]
REAL = os.environ["PROXY_FAKE_OPENAI"]


class Hello(BaseModel):
    greeting: str


def captured():
    with urllib.request.urlopen(f"{M}/__captured") as r:
        return json.load(r)


def main():
    client = instructor.from_openai(
        openai.OpenAI(base_url=f"{W}/v1", api_key=TOKEN), mode=Mode.TOOLS
    )
    try:
        client.create(
            model="gpt-4o-mini",
            response_model=Hello,
            max_retries=0,
            messages=[{"role": "user", "content": "say hi"}],
        )
    except Exception:
        # expected: parse fails by design; the forward already happened
        pass

    cap = captured()
    assert cap["path"] == "/v1/chat/completions", cap["path"]
    assert cap["headers"].get("authorization") == f"Bearer {REAL}", cap["headers"].get("authorization")
    assert TOKEN not in json.dumps(cap["headers"]), "proxy token leaked into upstream headers"
    print("PASS: instructor -> proxy swapped the real key, token never egressed")


if __name__ == "__main__":
    main()
