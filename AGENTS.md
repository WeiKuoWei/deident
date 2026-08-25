# AGENTS.md

This repository is a tool an agent operates. It is deident: it reads a person's
AI coding-agent session logs, removes the identities from them, and produces one
archive they can hand to a named recipient.

If you have been asked to export, share, hand over, submit, donate, anonymise or
de-identify session logs, or a user has named deident, then before you run
anything, read the operator contract:

```
skills/deident/SKILL.md
```

That file is the whole of it: the flow, what the tool refuses and why, the files
it reads and writes, and the two steps it cannot do for itself. This page states
none of that, on purpose, so there is nothing here to fall behind it.

Two properties to know before you open it, both true by construction rather than
by procedure, so neither can go stale:

- The tool makes no network calls and writes no archive until the last step.
  `node <repo>/deident.js --help` is safe to run at any moment.
- It refuses rather than degrading, and a refusal names its reason and a remedy.
  Do not route around one. The refusals are the product.

## Why this is a pointer and not the contract

It used to be the contract, duplicated here because harnesses disagree about
where to look. Both supported harnesses now resolve the skill through
`.claude-plugin/`, so the copy served only an agent reading this checkout
directly, which is one extra file read away from the real thing.

It cost more than it served. The two copies drifted twice: once leaving the
entity-kind list 62 commits behind, and once in the frontmatter, where the skill
carried trigger phrases this file had no way to hold. Both times a reader who
landed on the stale half had nothing telling them it was stale. A pointer cannot
drift, and an agent that cannot open a second file cannot run the CLI either.
