#!/usr/bin/env bash
# Regenerates, from the Mac's real code, what the Kotlin Notes port is checked against:
#  - android/core/src/main/kotlin/.../notes/UnicodeTables.kt: the Unicode data the Mac's
#    string code uses (tables/Tables.swift, tables/gen_tables.py)
#  - android/core/src/test/resources/notes/notes-vectors.jsonl.gz: expected outputs of
#    the pure Swift sources (TextMerge, MarkdownParser, NoteModel, SyncEngine,
#    ThoughtCapture, FuzzyMatch) built with this directory's generator.
# Copies everything to a scratch directory on a Mac and builds it with swiftc (Command
# Line Tools are enough). NoteModel.swift gets two test seams (a settable clock and
# sequential ids, see Stubs.swift) so the live-merge fuzz is deterministic.
#
#   android/core/xcheck/notes/generate.sh [ssh-host]     (default: mbp3)
set -euo pipefail
host="${1:-mbp3}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
remote_dir=/tmp/bento-xcheck-notes
local_dir="$(mktemp -d)"
trap 'rm -rf "$local_dir"' EXIT

for f in TextMerge MarkdownParser SyncEngine ThoughtCapture FuzzyMatch; do
  cp "$repo/Sources/Notes/$f.swift" "$local_dir/"
done
sed -e 's/static func now() -> Int64 { Int64(/static func now() -> Int64 { TestClock.now ?? Int64(/' \
    -e 's/init(id: String = UUID().uuidString,/init(id: String = TestClock.nextID(),/' \
    "$repo/Sources/Notes/NoteModel.swift" > "$local_dir/NoteModel.swift"
grep -q 'TestClock.now ??' "$local_dir/NoteModel.swift" && grep -q 'TestClock.nextID()' "$local_dir/NoteModel.swift" \
  || { echo "NoteModel.swift seams not applied" >&2; exit 1; }
cp "$here"/*.swift "$local_dir/"
mkdir -p "$local_dir/tables"
cp "$here/tables/Tables.swift" "$local_dir/tables/"

ssh "$host" "rm -rf $remote_dir && mkdir -p $remote_dir/tables"
scp -q "$local_dir"/*.swift "$host:$remote_dir/"
scp -q "$local_dir/tables/Tables.swift" "$host:$remote_dir/tables/"
ssh "$host" "cd $remote_dir/tables && swiftc -O -o tables Tables.swift -licucore && ./tables tables.json"
ssh "$host" "cd $remote_dir && swiftc -swift-version 5 -O -o xcheck *.swift && SWIFT_DETERMINISTIC_HASHING=1 ./xcheck notes-vectors.jsonl && swiftc --version 2>&1 | head -1 && sw_vers -productVersion"

scp -q "$host:$remote_dir/tables/tables.json" "$local_dir/"
python3 -I "$here/tables/gen_tables.py" "$local_dir/tables.json" "$repo/android/core/src/main/kotlin/com/charles/bento/core/notes/UnicodeTables.kt"
out="$repo/android/core/src/test/resources/notes"
mkdir -p "$out"
scp -q "$host:$remote_dir/notes-vectors.jsonl" "$local_dir/"
gzip -9 -n -c "$local_dir/notes-vectors.jsonl" > "$out/notes-vectors.jsonl.gz"
ls -l "$out/notes-vectors.jsonl.gz"
