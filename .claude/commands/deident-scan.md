---
description: Read deident-candidates.txt and write the tier-1 entity list deident refuses to export without.
---

You are the semantic (tier-1) entity pass for `deident`. The CLI makes no
network calls, so this pass is a file contract, and this command is the
"Inside Claude Code" remedy the export refusal names.

Steps:

1. Find `deident-candidates.txt` in the current directory, or in the `--out`
   directory the user named. If it is not there, run
   `node deident.mjs export --preview` first: that is what writes it.
2. Read it. It is prose only, and tier-0 substitution has ALREADY replaced the
   user's username, paths, git identity, git remotes, emails and MCP server
   names. What is left is what a machine cannot find on its own.
3. List every identity in that prose: people, companies, clients, product and
   codenames tied to a named party, and machine or host names. Include every
   spelling you actually see, including the run-together forms that appear in
   filenames and handles (`AdaWang`, `CatalyteAI`, `example.net`), because
   the boundary rule treats those as separate strings.
4. Write `deident-entities.json` next to the candidates file:

   ```json
   {
     "generated": "<ISO timestamp>",
     "entities": [
       {"kind": "person", "spellings": ["Ada Wang", "AdaWang", "Ada"], "confidence": "high"},
       {"kind": "org",    "spellings": ["Acme Advisory"],                  "confidence": "low"}
     ]
   }
   ```

   `kind` is one of `person | org | client | workspace | machine`.
   `confidence` is `high` or `low`. Mark it `low` whenever you are guessing;
   low-confidence entities are listed individually in the review and are never
   collapsed into a count.
5. Tell the user to run
   `node deident.mjs export --entities deident-entities.json`, and remind them
   that the residue line reads `known-entity residue`, not "safe": anything you
   missed here is invisible to the scan.

Rules:

- Third parties never consented, so include them. Do not ask which ones to skip.
- Do not invent entities that are not in the file, and do not add ordinary
  English words: over-substitution destroys the prose and gets the tool
  switched off.
- Do not copy the candidates file, or excerpts of it, anywhere except into the
  entity list you write.
