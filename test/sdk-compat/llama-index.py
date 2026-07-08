#!/usr/bin/env python3
"""LlamaIndex compatibility smoke test (thin client; the Node runner owns the worker + mock).

Drives all three LlamaIndex LLM integrations (OpenAI, Anthropic, GoogleGenAI) through the worker and
asserts the mock saw the real key swapped into the right slot, with the proxy token nowhere. Each
integration just wraps the official provider SDK, so this proves LlamaIndex forwards base_url + key
through cleanly for every provider.

Run it (also part of `nub run test`):  nub run test:py
"""

import json
import os
import urllib.request

from google.genai import types
from llama_index.core.llms import ChatMessage
from llama_index.llms.anthropic import Anthropic
from llama_index.llms.google_genai import GoogleGenAI
from llama_index.llms.openai import OpenAI

W = os.environ["PROXY_WORKER_URL"]
M = os.environ["PROXY_MOCK_URL"]
TOKEN = os.environ["PROXY_TOKEN"]


def captured():
    with urllib.request.urlopen(f"{M}/__captured") as r:
        return json.load(r)


def reset():
    urllib.request.urlopen(f"{M}/__reset").read()


def msg():
    return [ChatMessage(role="user", content="hi")]


def main():
    # Real model ids are required: the OpenAI/Anthropic classes look up the context window from
    # the model name and raise on an unknown id (the request still goes to the worker regardless).

    # 1) OpenAI -> Authorization: Bearer -> /v1/chat/completions
    reset()
    OpenAI(api_base=f"{W}/v1", api_key=TOKEN, model="gpt-4o").chat(msg())
    cap = captured()
    assert cap["path"] == "/v1/chat/completions", cap["path"]
    assert cap["headers"].get("authorization") == f"Bearer {os.environ['PROXY_FAKE_OPENAI']}"
    assert TOKEN not in json.dumps(cap["headers"]), "token leaked (openai)"

    # 2) Anthropic -> x-api-key -> /v1/messages  (base_url is the bare host)
    reset()
    Anthropic(
        base_url=W, api_key=TOKEN, model="claude-sonnet-4-6", max_tokens=16
    ).chat(msg())
    cap = captured()
    assert cap["path"] == "/v1/messages", cap["path"]
    assert cap["headers"].get("x-api-key") == os.environ["PROXY_FAKE_ANTHROPIC"]
    assert TOKEN not in json.dumps(cap["headers"]), "token leaked (anthropic)"

    # 3) GoogleGenAI -> x-goog-api-key -> /v1beta/models/<model>:generateContent
    # Pass max_tokens AND context_window so __init__ skips a live models.get() validation call.
    reset()
    GoogleGenAI(
        api_key=TOKEN,
        model="gemini-2.5-flash",
        max_tokens=16,
        context_window=1000000,
        http_options=types.HttpOptions(base_url=W),
    ).chat(msg())
    cap = captured()
    assert "/v1beta/models/gemini-2.5-flash:generateContent" in cap["path"], cap["path"]
    assert cap["headers"].get("x-goog-api-key") == os.environ["PROXY_FAKE_GEMINI"]
    assert TOKEN not in json.dumps(cap["headers"]), "token leaked (gemini)"

    print("PASS: llama-index (openai + anthropic + google-genai) -> proxy swapped each real key, token never egressed")


if __name__ == "__main__":
    main()
