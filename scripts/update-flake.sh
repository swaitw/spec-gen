#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

FLAKE="flake.nix"
PKG="package.json"
LOCK="package-lock.json"

if [[ ! -f "$FLAKE" ]]; then echo "Error: $FLAKE not found"; exit 1; fi
if [[ ! -f "$PKG" ]]; then echo "Error: $PKG not found"; exit 1; fi

# --- Version sync ---
new_version=$(jq -r .version "$PKG")
old_version=$(sed -n 's/.*version = "\([^"]*\)".*/\1/p' "$FLAKE")

if [[ "$old_version" == "$new_version" ]]; then
  echo "Version already in sync: $new_version"
else
  sed -i "s/version = \"$old_version\"/version = \"$new_version\"/" "$FLAKE"
  echo "Version: $old_version → $new_version"
fi

# --- Ensure lockfile is in sync ---
echo "Syncing package-lock.json..."
npm install --package-lock-only --ignore-scripts --silent 2>/dev/null

# --- Compute npmDepsHash ---
echo "Computing npmDepsHash (this may take a moment)..."
if command -v prefetch-npm-deps &>/dev/null; then
  new_hash=$(prefetch-npm-deps "$LOCK" 2>/dev/null)
elif command -v nix-shell &>/dev/null; then
  new_hash=$(nix-shell -p prefetch-npm-deps --run "prefetch-npm-deps $LOCK" 2>/dev/null)
else
  echo "Error: prefetch-npm-deps not found and nix-shell not available"
  exit 1
fi

old_hash=$(sed -n 's/.*npmDepsHash = "\([^"]*\)".*/\1/p' "$FLAKE")

if [[ "$old_hash" == "$new_hash" ]]; then
  echo "npmDepsHash unchanged: $new_hash"
else
  # Escape slashes in hash for sed
  escaped_old=$(printf '%s\n' "$old_hash" | sed 's/[/&]/\\&/g')
  escaped_new=$(printf '%s\n' "$new_hash" | sed 's/[/&]/\\&/g')
  sed -i "s|npmDepsHash = \"$escaped_old\"|npmDepsHash = \"$escaped_new\"|" "$FLAKE"
  echo "npmDepsHash: $old_hash → $new_hash"
fi

echo ""
echo "Done. Review changes with: git diff flake.nix"
