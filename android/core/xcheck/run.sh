#!/usr/bin/env bash
# Regenerates the cross-check vectors in src/test/resources/xcheck/ from the Mac's real Swift
# code. Needs a Mac with the Swift command line tools reachable over ssh (default: mbp3);
# builds in a scratch directory there and never touches a checkout or a running Bento.
#
#   android/core/xcheck/run.sh [host]
set -euo pipefail
host="${1:-mbp3}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
scratch=/tmp/bento-xcheck-todo
out="$here/../src/test/resources/xcheck"

ssh "$host" "rm -rf $scratch && mkdir -p $scratch"
scp -q "$here/main.swift" \
  "$repo/Sources/Todo/TodoModel.swift" "$repo/Sources/Todo/DateParser.swift" \
  "$repo/Sources/Todo/QuickAddParser.swift" "$repo/Sources/Todo/TodoSyncEngine.swift" \
  "$repo/Sources/Todo/TodoQueries.swift" "$host:$scratch/"
ssh "$host" "cd $scratch && swiftc -O -swift-version 5 main.swift TodoModel.swift DateParser.swift QuickAddParser.swift TodoSyncEngine.swift TodoQueries.swift -o xcheck 2>&1 | grep -v warning: | grep -v '^ *|' || true; ./xcheck"
ssh "$host" "cd $scratch/out && gzip -9 -n -f *.json"
mkdir -p "$out"
rm -f "$out"/*.json.gz
scp -q "$host:$scratch/out/*.json.gz" "$out/"
ls -l "$out"
