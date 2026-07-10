#!/usr/bin/env python3
"""Exercise Pydantic AI's OpenAI Chat Completions client through the proxy."""

import json
import os
import urllib.request

from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

W = os.environ["PROXY_WORKER_URL"]
M = os.environ["PROXY_MOCK_URL"]
TOKEN = os.environ["PROXY_TOKEN"]
REAL = os.environ["PROXY_FAKE_OPENAI"]


def captured():
    with urllib.request.urlopen(f"{M}/__captured") as r:
        return json.load(r)


def main():
    model = OpenAIChatModel(
        "gpt-4o", provider=OpenAIProvider(base_url=f"{W}/v1", api_key=TOKEN)
    )
    result = Agent(model).run_sync("hi")
    assert "hi" in str(result.output), result.output

    cap = captured()
    assert cap["path"] == "/v1/chat/completions", cap["path"]
    assert cap["headers"].get("authorization") == f"Bearer {REAL}", cap["headers"].get("authorization")
    assert TOKEN not in json.dumps(cap["headers"]), "proxy token leaked into upstream headers"
    print("PASS: pydantic-ai -> proxy swapped the real key, token never egressed")


if __name__ == "__main__":
    main()
