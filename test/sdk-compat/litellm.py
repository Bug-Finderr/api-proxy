#!/usr/bin/env python3
"""LiteLLM compatibility smoke test (separate Python runner - the Node compat tier can't host it).

Brings up the worker locally (`wrangler dev`) with its OpenAI upstream pointed at a Python mock,
seeds a proxy token via the admin API, drives LiteLLM against the worker, and asserts the mock saw
the real key swapped in and the proxy token nowhere.

One-time setup (from the repo root):
    python -m venv .venv
    .venv/Scripts/python -m pip install -r test/sdk-compat/requirements.txt   # *nix: .venv/bin/python
Run it (also runs as part of `nub run test`):
    nub run test:py
"""

import sys

# This file is named after the package (per the sdk-compat naming convention), so its own
# directory would shadow `import litellm`; drop the script dir from sys.path before importing it.
sys.path.pop(0)

import http.server
import json
import os
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FAKE_OPENAI_KEY = "FAKE-OPENAI-KEY"
ADMIN_SECRET = "litellm-admin-secret"
TOKEN = "tk-litellm"

captured = {}


class MockHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        captured["path"] = self.path
        captured["headers"] = {k.lower(): v for k, v in self.headers.items()}
        captured["body"] = self.rfile.read(n).decode() if n else ""
        body = json.dumps(
            {
                "id": "chatcmpl_1",
                "object": "chat.completion",
                "created": 0,
                "model": "x",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "hi"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }
        ).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_ready(base, timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(base + "/admin", timeout=2)
            return True
        except urllib.error.HTTPError:
            return True  # any HTTP response means the worker is serving
        except Exception:
            time.sleep(0.7)
    return False


def post(url, fields, cookie=None):
    headers = {"content-type": "application/x-www-form-urlencoded"}
    if cookie:
        headers["cookie"] = cookie
    data = urllib.parse.urlencode(fields).encode()
    return urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers))


def main():
    mock_port, worker_port = free_port(), free_port()
    mock = http.server.HTTPServer(("127.0.0.1", mock_port), MockHandler)
    threading.Thread(target=mock.serve_forever, daemon=True).start()

    env = dict(os.environ, CI="1")
    cmd = [
        "npx", "wrangler", "dev",
        "--port", str(worker_port), "--ip", "127.0.0.1",
        "--var", f"OPENAI_API_KEY:{FAKE_OPENAI_KEY}",
        "--var", "ANTHROPIC_API_KEY:FAKE-ANTHROPIC-KEY",
        "--var", "GEMINI_API_KEY:FAKE-GEMINI-KEY",
        "--var", f"ADMIN_SECRET:{ADMIN_SECRET}",
        "--var", f"OPENAI_UPSTREAM:http://127.0.0.1:{mock_port}",
    ]
    worker = subprocess.Popen(
        cmd, cwd=REPO, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        shell=(os.name == "nt"),
    )
    try:
        base = f"http://127.0.0.1:{worker_port}"
        if not wait_ready(base):
            raise SystemExit("worker did not become ready")

        login = post(f"{base}/admin/login", {"password": ADMIN_SECRET})
        cookie = login.headers.get("set-cookie", "").split(";")[0]
        post(
            f"{base}/admin/api/tokens",
            [("label", TOKEN), ("token", TOKEN), ("providers", "openai")],
            cookie,
        )

        import litellm

        litellm.completion(
            model="openai/gpt-x",
            api_base=f"{base}/v1",
            api_key=TOKEN,
            messages=[{"role": "user", "content": "ping-from-litellm"}],
            max_tokens=5,
        )

        h = captured.get("headers", {})
        assert captured.get("path") == "/v1/chat/completions", captured.get("path")
        assert h.get("authorization") == f"Bearer {FAKE_OPENAI_KEY}", h.get("authorization")
        assert TOKEN not in json.dumps(h), "proxy token leaked into upstream headers"
        assert "ping-from-litellm" in captured.get("body", ""), "request body not forwarded"
        print("PASS: litellm -> proxy swapped the real key, token never egressed, body forwarded verbatim")
    finally:
        worker.terminate()
        try:
            worker.wait(timeout=10)
        except Exception:
            worker.kill()
        mock.shutdown()


if __name__ == "__main__":
    main()
