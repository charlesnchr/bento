# Helper tests

Offline unit tests for the helpers: no credentials, microphone or cloud calls. Run them from the repo root with a Python that has `helper/requirements.txt` installed (Hermes's venv has everything):

    ~/.hermes/hermes-agent/venv/bin/python -m unittest discover -s helper/tests -t helper

`test_hermes_acp.py` needs the Hermes checkout at `~/.hermes/hermes-agent` and is skipped without it. It runs Hermes's real session database code against a temporary database. Run it on its own with `~/.hermes/hermes-agent/venv/bin/python helper/tests/test_hermes_acp.py`, and add `--live` to also start the real launcher and check its `_bento/*` routing. That sends no prompt.
