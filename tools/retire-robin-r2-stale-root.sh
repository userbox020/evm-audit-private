#!/usr/bin/env bash
set -euo pipefail

root="$HOME/.local/share/evm-audit/robin-runtime-r2"
parent="$HOME/.local/share/evm-audit"
archive="/mnt/c/_Work/__EVM_AUDIT/reports/raw/fast/polygon-robin-markets-staking-vault-v2.0.0-runtime-r2/superseded-native-preflight"

test -d "$root"
test ! -L "$root"
test "$(realpath "$root")" = "$root"
test "$(stat -c %u "$root")" = "1000"
test "$(stat -c %a "$root")" = "700"
test "$(findmnt -n -o FSTYPE -T "$root")" = "ext4"
test -z "$(findmnt -R -n -o TARGET "$root" 2>/dev/null || true)"
test -z "$(lsof -t +D "$root" 2>/dev/null || true)"

test "$(find "$root" -mindepth 1 -maxdepth 1 | wc -l)" = "8"
for name in capability-seal.json capability-test lifecycle reports review-input reviews staging-seal.json tools; do
  test -e "$root/$name"
done
for name in lifecycle reviews review-input capability-test; do
  test -d "$root/$name"
  test -z "$(find "$root/$name" -mindepth 1 -maxdepth 1 -print -quit)"
done

for file in staging-seal.json capability-seal.json; do
  test -f "$root/$file"
  test ! -L "$root/$file"
  test "$(stat -c %u "$root/$file")" = "1000"
  test "$(stat -c %h "$root/$file")" = "1"
done

test "$(sha256sum "$root/staging-seal.json" | cut -d ' ' -f1)" = "d20b570b1f819e5b59a2eca7a2391d897af72b1ee639649c6b91d2b6b107fd05"
test "$(sha256sum "$root/capability-seal.json" | cut -d ' ' -f1)" = "7efde8503bf21de1f9e8dfefd765daa5a4dde84c717c61419861643c0061c57e"
grep -q "9d481681dcb87f4d10adbc952d7882e58a586c8d249791ae59fc1e3ec89a1c2d" "$root/staging-seal.json"
grep -q "cc7cad30c5d9ac3283b7879066758924ccb299a87e12d61a9d06f1a445163e09" "$root/staging-seal.json"
grep -q "4802571ec86a9df617d932de1341a84e3123d0dd1ace99475af94e67fd28a021" "$root/staging-seal.json"

test ! -e "$archive"
mkdir -m 0700 "$archive"
cp --no-dereference "$root/staging-seal.json" "$archive/staging-seal.superseded.noncanonical.json"
cp --no-dereference "$root/capability-seal.json" "$archive/capability-seal.superseded.noncanonical.json"
test "$(sha256sum "$archive/staging-seal.superseded.noncanonical.json" | cut -d ' ' -f1)" = "d20b570b1f819e5b59a2eca7a2391d897af72b1ee639649c6b91d2b6b107fd05"
test "$(sha256sum "$archive/capability-seal.superseded.noncanonical.json" | cut -d ' ' -f1)" = "7efde8503bf21de1f9e8dfefd765daa5a4dde84c717c61419861643c0061c57e"

dev="$(stat -c %d "$root")"
ino="$(stat -c %i "$root")"
test "$(stat -c %d "$root")" = "$dev"
test "$(stat -c %i "$root")" = "$ino"
rm -rf --one-file-system -- "$root"
python3 -c 'import os,sys; fd=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY); os.fsync(fd); os.close(fd)' "$parent"
test ! -e "$root"

echo ROBIN_RUNTIME_R2_STALE_ROOT_RETIRED
