# Sanitized source snapshot

This is a sanitized first-party source snapshot, NOT a full machine backup or a
runnable runtime backup. The seven required read-only recovery files are included
unchanged only if accepted by the same selection and scanning policy.

Excluded: secrets, wallets/keys, endpoint inventories, live authorizations, state
and history, runtime artifacts, dependencies, nested third-party checkouts,
unreviewed research and unclassified roots. Original files are never modified.
Local configuration, dependencies and separately authorized runtime data may be
needed. No signing, live execution, scheduling or publishing authority is granted.

Scanning provides bounded heuristic assurance, not a guarantee of absence of
secrets (encoded, split, indirect or unfamiliar credentials can evade detection).
Use a quiescent source and destination: metadata/handle checks detect common
races, but this is not a sandbox against hostile concurrent filesystem mutation.
The manifest checks integrity, not provenance or authenticity. Generated controls
are verified separately; the manifest indexes accepted source files only.
Exclusion counts describe pruned entries/categories, not every descendant of a
pruned directory. Suspected material, its paths and its hashes are not recorded.
Only explicitly allowed paths are unignored; never force-add excluded files.
