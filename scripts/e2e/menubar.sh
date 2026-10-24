#!/bin/bash
# Obsolete: the old script drove synthetic menu item moves through profiles.
# Cursor automation and profile execution have been removed from MenuBar.
# Manual macOS validation is documented in docs/QA.md. This script deliberately
# exits before building, launching apps, editing settings or posting input.
printf '%s\n' 'OBSOLETE: MenuBar now uses native manual Command-drag. Follow docs/QA.md for an isolated manual smoke test.' >&2
exit 2
