# Every flag, and every exit code

`node deident.js --help` prints the short form. This is the long one, with the
reason attached where the reason is what you need. A flag a command does not
accept is an error, not a silent no-op.

`--json` and `--batch-chars` are real flags that `--help` does not yet list.

| Flag | Commands | Meaning |
|---|---|---|
| `--root <path>` | all | Override the resolved session-storage root. Default: `CLAUDE_CONFIG_DIR`, else `~/.claude`. Sessions are read from `<root>/projects/*/*.jsonl`, depth 0 only. |
| `--out <path>` | all | Output directory. Default: the current directory. |
| `--salt-dir <path>` | all | Override `~/.deident-private`, which holds the salt, your saved tier decisions, the entity dictionary, `denied.json`, `known-values.json` and the occurrence index. Pointing it at an empty directory starts you over completely, so **copy `denied.json` and `known-values.json` across first**: without the first, none of your deny rules load and a directory you expect to be excluded is proposed at `redact` with every check green; without the second, every value you declared as your own goes back to being something a reader has to spot. deident warns when the directory in use is missing either one and the default one has it. |
| `--json` | all | Emit the result as JSON instead of padded columns, for an agent driving the tool. |
| `--html` | `review` | Write one self-contained `review.html`. Cannot be combined with `--entity` or `--session`. |
| `--entity <ID>` | `review` | Print every occurrence of one entity. Refuses until an export has run. |
| `--session <id>` | `review` | Print one full redacted transcript. Refuses until an export has run. |
| `--triage-chars <n>` | `triage` | Characters of the first user prompt to show per session. Default 300, maximum 2,000. A limit high enough to carry whole sessions turns triage back into the expensive stage. |
| `--apply` | `triage` | Merge a verdicts file into `review.md` instead of writing the triage file. Needs `--verdicts`. |
| `--verdicts <file>` | `triage` | The verdicts file to apply. `verdict` is `drop` or `unsure`; `keep` is refused, because a triage verdict may only ever move a session toward `drop`. |
| `--preview` | `export` | Write a `.diff` to inspect in your own editor instead of a zip. |
| `--entities <file>` | `export` | The tier-1 (semantic) entity list, as JSON. Optional once `~/.deident-private/entities.json` holds one: absent, the dictionary supplies the list; present, the file wins on the identities it names and the dictionary supplies the rest. Without either, the export is refused. |
| `--full` | `export` | Ignore what deident remembers you having read and put the whole corpus in front of a reader again. Refuses the export and writes the full `deident-candidates.txt`. Cannot be combined with `--entities`. |
| `--namespace <TAG>` | `export` | Shift the pseudonym namespace: `X` gives `X_PERSON_01`. Must match `[A-Z][A-Z0-9]{0,7}`. For a corpus that already contains tokens of the default shape. |
| `--batch-chars <n>` | `export` | How much prose one run puts in `deident-candidates.txt` before deferring the rest. Default 120,000 characters, roughly 30k tokens. Only the sessions actually in the file are recorded as read, so a smaller number means more rounds, never a weaker claim. |
| `--skip-unclassified` | `export` | Confirm that workspaces you never gave a tier stay out. Without it, an unclassified workspace refuses the export rather than being silently dropped. |
| `--skip-unreadable` | `scan`, `export` | Continue past a line that is not valid JSON instead of exiting 3. Each skipped line is reported. |
| `--skip-unknown-types` | `scan`, `export` | Drop records whose type deident has never seen instead of refusing. The dropped types and counts are printed in the "NOT protected against" block. Refusal stays the default; this exists because a harness ships a new record type every few weeks and one such line should not block a whole export. |
| `--include-denied <name>` | `export` | Typed confirmation for one deny-listed workspace. Exact name, no globs. Repeatable. |
| `--selftest` | global | Run the fixture suite and exit. |
| `--help` | global | Print usage and exit 0. |
| `--version` | global | Print the version and exit 0. |

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | success, or an informational command |
| 1 | a check failed, or the export was refused. Nothing was written. |
| 2 | bad usage. Usage text printed. |
| 3 | an input could not be read and `--skip-unreadable` was not given |

Any non-zero exit leaves no output file behind. Verification happens before
anything is written, never after.
