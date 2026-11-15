#!/bin/sh
# Keeps a suite's runs in eval/results/<name>: report.txt (what report.ts prints) and runs.tar.gz
# (each call's log, scenario and judge verdict; not its trace, which holds the audio).
#
#   eval/keep.sh eval/runs/s1-base baseline
set -eu
cd "$(dirname "$0")/.."
run="${1%/}"; name="$2"; out="eval/results/$name"
[ -d "$run" ] || { echo "no such run: $run" >&2; exit 1; }
mkdir -p "$out"
node eval/report.ts "$run" > "$out/report.txt"
(cd "$(dirname "$run")" && find "$(basename "$run")" \( -name log.jsonl -o -name scenario.json -o -name judge.json \) | sort) \
  | tar -cf - --mtime=@0 --owner=0 --group=0 --numeric-owner --transform "s,^$(basename "$run"),$name," -C "$(dirname "$run")" -T - \
  | gzip -n > "$out/runs.tar.gz"
echo "$out: $(tar -tzf "$out/runs.tar.gz" | grep -c log.jsonl) calls"
