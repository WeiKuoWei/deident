# Why deident works the way it does

The reasons behind the parts of the tool that look like friction: a mandatory
reading step, a workspace list that starts empty, and pseudonyms nothing can
reverse for you. Each one is here because the cheaper alternative was measured
and was worse.

`README.md` says what the tool does. This file says why, and it is the argument
to read before deciding whether to trust an archive produced by it.

## What the stages cost

Measured 2026-08-24 on a 205-session corpus: `triage` reads 23 KB, because it
reads only the head of each session file, and `export --preview` read 915 KB, a
35x difference for the stage that decides whether a session ships at all.

That 915 KB was measured while the candidates file truncated every prose chunk at
400 characters and deduplicated on the first 80 of each. It no longer does either,
because both losses were silent and neither was counted. Measured over the whole
depth-0 corpus with the same workspace decisions before and after, removing them
multiplies stage 3 by **3.95** (2,957,659 bytes to 11,684,461). So budget stage 3
near 3.5 MB and about 900k tokens on a corpus that size, and read the 3.5 MB in
the README's table as that projection rather than as a measurement. Stage 2 got
cheaper relative to stage 3 by the same factor, so the argument for running it is
now much stronger than 35x.

A per-chunk limit of 20,000 characters remains, which on that corpus cut
1,336,271 characters, 10.3% of the prose. That number is printed beside the file
path, written into the file itself and carried as `candidates.omittedChars` in
`--json`, because a reader handed a short file has to be told it is short.

## The semantic pass is mandatory

Entity discovery from prose is required, and if it did not run the export is
**refused**. This is not a nag. The residual scan can only find entities it
already knows about, so without the semantic pass a zero-residue result would be
meaningless: it would report that deident found none of the names it was told
about, which is true of an empty list too.

The gate is **per session**. Every session in an export must have been through a
pass, in this run or in a recorded earlier one, and a session that is new or
changed refuses the export by name. That is stricter than the whole-corpus flag
it replaced, including for runs that use no dictionary at all: `export
--entities an-old-list.json` over a corpus that has grown used to ship the new
sessions on the strength of a list written before they existed.

The candidates file carries **cleaned** prose, never the raw records. Handing raw
text to a discovery pass would ship unredacted paths, your username and your
emails into the discovery context: a privacy tool leaking inside its own privacy
step.

A malformed entity list is refused, never silently treated as an empty one. An
empty list would satisfy "the pass ran" while delivering nothing.

The instructions for the pass live once, in `skills/deident/SKILL.md`.
`AGENTS.md` points any other agent at that path rather than restating it, and
fixture F103 asserts the pointer still resolves: the path is there, the file it
names is the operator contract, and `AGENTS.md` has not grown back into a copy.
Nothing harness-specific has to be installed and there is no slash command to
run.

## Opt-in, never opt-out

**Nothing deident proposes is exportable.** `redact` and `open` are reached only
by a person typing one of them into `review.md`; every proposal the tool makes
by itself is `exclude` or `unclassified`. A workspace it has not seen before is
excluded, and it is never swept in.

This used to be weaker in one specific way, and the weakness is what two
shipped exports leaked through. A directory with a git remote was proposed
`redact`, `scan` wrote that word into column 1 of `review.md`, and reading the
file back could not tell a proposal from an answer. So `scan` followed by
`export`, with no edit in between, admitted every remote-bearing workspace on
the machine. Measured on the live corpus after the change: 14 workspaces
exported on tiers already recorded, and 3 more that the old proposal would have
swept in unasked.

A git remote is evidence that a directory is a repository. It is not evidence
that its contents may be handed to someone. What the gate buys is not another
check but a bound: whatever the substitution still misses can only be missed
inside a workspace that was named by hand, and that is a sentence the manifest
can carry.

The cost is one typed word per workspace a person actually wants, and the census
and the refusal both name the rows that carry a remote so the first run is a
short list rather than 31 questions.

Beyond that, a workspace whose name (or whose per-line `cwd`) contains `private`,
`identity`, `payroll` or a token you add to `~/.deident-private/denied.json` is
excluded and needs `--include-denied <exact-name>` typed out to include.

The three shipped tokens are English words and match nothing else, and the
"reads like personal data" check beside them is English words too. So a
workspace whose name contains any non-ASCII character is proposed
`unclassified`, which means excluded until you decide it, however ordinary the
name is: neither list can read it, and silence from an instrument that could not
look is not a clearance. Decide it once in `review.md`, or put your own token in
`denied.json` and it is excluded for good. One token there feeds the workspace
check and the per-line `cwd` check alike.

The per-line `cwd` filter matters more than it sounds. The largest session file
on the development machine spans **11 distinct working directories**, two of them
under a `private` path, inside a workspace that is not itself deny-listed.
Opting in at the directory level alone would have exported payroll material. In
the delivery run of 2026-08-22, 612 lines were dropped by this filter from
workspaces that were otherwise included, and a further 32 records were withheld
because they replay text typed inside an excluded directory and carry no cwd of
their own.

## Reversal, and the salt

Pseudonyms are `sha256(salt + kind + entity)`. The salt lives at
`~/.deident-private/salt` and is **never** written into any output, manifest,
preview or log line. It is 64 hexadecimal characters, and deident refuses to use
a file that is anything else: a zeroed or truncated salt would silently produce
predictable pseudonyms, which is this whole mechanism defeated in a way nothing
downstream could see.

**On Windows the file's protection is the directory it sits in, and nothing
else.** deident asks for mode `0600`, and NTFS ignores it: `icacls` on the
created file shows only inherited entries. That is honest rather than fixed (the
user profile directory is already user-scoped and any local administrator can
read the file regardless), but do not read `mode: 0600` in the source as a
guarantee. If you want more, set an explicit ACL on `~/.deident-private`
yourself.

**Do not share the salt and do not commit it.** Anyone who has both the salt and
a guess at your entity list can confirm the guess. It is the only thing standing
between a pseudonym and the name behind it, and it is per-uploader for that
reason: seven people uploading to one recipient who also holds the roster is a
seven-way guess, and a shared salt would mean cracking one cracks all.

There is deliberately **no plaintext entity-to-pseudonym map**. Such a file is a
portable re-identification key for data that has already left the machine, and
the raw logs are not. To reverse, regenerate the entity list locally and hash the
candidates.

**That reversal path has one blind spot, and the manifest names it.** Where two
declared entities overlap in the text, the substituter replaces the union and
emits both tokens, so the token they shared is gone: `Ada Wren Wang` and
`Ada Wren Reed Wang` produce the same output. The substitution invariant still
passes, because it reverses from the spans the pass produced, but the spans live
in memory and are never written down, so regenerating the entity list cannot
tell those two inputs apart. The export prints the count of merged replacements
for exactly this reason.

## The declared audience moves the entity list, not the sessions

`--audience` was first put on the session decision: sessions were held back at
`public` and released for a declared insider. Measured on the live corpus at
`audience=teammate`: 151 sessions held by the floor, **0 held by the audience**,
and zero occurrences of the token in the `review.md` the tool produced. It asked
the operator to classify every held row against a distinction that changed
nothing, while defining `public` as the setting that ships the fewest sessions.
The expected user publishes publicly, so the design gave its main case the worst
archive. Whole-session removal took that funnel from 35 sessions to 17; removing
parts of a session instead took it back to 76.

So the axis now moves what goes **into** the entity list and never which sessions
ship. At `public` your own repository name is an identity, because it names your
employer to a reader who does not already know it. At `teammate` or `company` it
is a word the reader uses daily, and substituting it wrecks the sentence while
hiding nothing. More privacy and more sessions stopped competing.

Your repository's **owner** is seeded at every audience and is deliberately not
on the axis: tier 0 cannot tell an employer's own org from a client's org you
happen to have a checkout under, and the failure direction of guessing wrong is
shipping a client's name to a stranger.

`docs/audience-and-floor.md` has the full record.

## Installing copies the repository, and updating does not re-copy it

Nothing Codex-specific is checked in, because Codex falls back to the Claude
manifests. It looks for a plugin manifest at `.codex-plugin/plugin.json`, then
`.claude-plugin/plugin.json`, then `.cursor-plugin/plugin.json`, and for a
marketplace at `.agents/plugins/marketplace.json`, then
`.agents/plugins/api_marketplace.json`, then `.claude-plugin/marketplace.json`.
The second file in each chain is one this repository already needs. Fixture F151
asserts the two manifests and the skill still agree on one name.

Both harnesses copy the checkout into a version-keyed cache directory and load
the skill from that copy, never from your working tree:

```
~/.claude/plugins/cache/deident/deident/<version>/
~/.codex/plugins/cache/deident/deident/<version>/
```

So editing `skills/deident/SKILL.md` changes nothing an agent can see, and the
commands that look like they would fix that report success while doing nothing.
Verified 2026-08-24 on Windows: after editing the skill, `claude plugin
marketplace update` and `claude plugin update` both reported "already at the
latest version" and left the old copy in place, because the check is on the
`version` string in `.claude-plugin/plugin.json` and not on the content. `codex
plugin marketplace upgrade` prints `No configured Git marketplaces to upgrade`
and exits 0, because it refreshes git-backed marketplaces only and a local path
is not one.

After changing anything a user of the plugin sees, bump `version` in
`.claude-plugin/plugin.json`, then:

```
claude plugin marketplace update deident
claude plugin update deident@deident      # says: Restart to apply changes
```

Codex has a way out that works at an unchanged version, and so does Claude Code
if you are willing to reinstall rather than cut a version:

```
codex plugin remove deident@deident && codex plugin add deident@deident
claude plugin uninstall deident@deident && claude plugin install deident@deident
```

Measured with a marker added to the skill's `description`: `codex debug
prompt-input` kept showing the old description until that pair ran, then showed
the new one. Two copies of the operator contract drifted twice, the second time
in the frontmatter where a body comparison could not have seen it, which is why
`AGENTS.md` is a pointer now rather than a copy.

While editing the skill, the honest move is to skip installing and point the
agent at the checkout.

## Why the decision is a text file

`review.md` is both the report and the config. The decision is made by editing a
text file, not by answering prompts: an engineer trusts a file they can grep,
diff and keep, and a prompt sequence cannot be reviewed by a second person.

The same reasoning runs through the rest of the interface. `deident` with no
arguments prints usage and exits 0, because the default action of a tool that
ships data off a machine should be to show you what it would do. A flag a
command does not accept is an error rather than a silent no-op, because
`--preview` quietly ignored by `scan` is how a surprise export happens. And
verification happens before anything is written, so any non-zero exit leaves no
output file behind.
