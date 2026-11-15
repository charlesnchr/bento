"""Network baseline from this machine: how much of each latency is just the path.

  .venv/bin/python net_baseline.py

Times 10 warm-connection round trips of a cheap authenticated GET on each host (Vertex through the proxy
when one is set, Azure OpenAI and Azure Speech direct), plus raw TCP connect times (direct, no API call) to the
same hosts. Writes data/net_baseline.json.
"""
import socket
import time

import requests

from urllib.parse import urlparse

from common import VERTEX_PROJECT, azure, azure_speech, google_session, google_token, save, summary


def tcp(host, n=5):
    out = []
    for _ in range(n):
        t = time.perf_counter()
        s = socket.create_connection((host, 443), timeout=5); s.close()
        out.append(time.perf_counter() - t)
    return summary(out)


def rtts(sess, url, headers, n=10):
    sess.get(url, headers=headers, timeout=30)          # warm the connection
    out = []
    for _ in range(n):
        t = time.perf_counter(); r = sess.get(url, headers=headers, timeout=30); out.append(time.perf_counter() - t)
    return {"status": r.status_code, **summary(out)}


res = {}
g = google_session(); h = {"Authorization": f"Bearer {google_token()}", "x-goog-user-project": VERTEX_PROJECT}
res["vertex_global"] = rtts(g, "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash", h)
res["vertex_uscentral1"] = rtts(g, "https://us-central1-aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash", h)
res["cloud_tts"] = rtts(g, "https://texttospeech.googleapis.com/v1/voices?languageCode=en-GB", h)
az = requests.Session(); az.trust_env = False
ep, key = azure()
res["azure_openai"] = rtts(az, f"{ep}/openai/deployments/gpt-5.4-nano?api-version=2023-03-15-preview", {"api-key": key})
speech, speech_key = azure_speech()
res["azure_speech"] = rtts(az, f"{speech}/speechtotext/models/base?api-version=2024-11-15&top=1", {"Ocp-Apim-Subscription-Key": speech_key})
for name, host in [("vertex_global", "aiplatform.googleapis.com"), ("vertex_uscentral1", "us-central1-aiplatform.googleapis.com"),
                   ("azure_openai", urlparse(ep).hostname), ("azure_speech", urlparse(speech).hostname)]:
    res[f"tcp_connect_direct_{name}"] = tcp(host)
save("net_baseline.json", res)
for k, v in res.items():
    print(f"{k:60s} median={v.get('median')} p90={v.get('p90')} {v.get('status', '')}")
