---
name: backlog-worker
description: The contract for a Claude Code session or subagent executing ONE backlog ticket (BL_TICKET is set, or you were handed `bl prompt <KEY>`, or you just ran `bl claim`). Covers reading the spec and upstream results, scoping, filing discovered work as new tickets, progress notes, fanning out to subagents for big tickets, honoring the repo's review policy, and finishing with exactly one of bl done / bl fail / bl release.
---

# backlog-worker: how to work one ticket

You hold a lease on one ticket in the shared backlog (`bl`, SQLite). You may have been started by the background daemon, by a `bl run` orchestrator, or by a session. Other agents run in parallel and read what you write, so the database is the record of what happened, not your chat. If `~/.backlog/LOCAL.md` exists, read it: it holds this machine's conventions, such as where design docs live and PR description format.

1. **Load the context.** Read `bl show $BL_TICKET`, or the prompt you were given. Read any design docs it names. Read the results of the upstream tickets, which tell you what already exists (PRs, APIs, paths).
   - **Look around before you start.** The prompt's "The project right now" section lists what else is in flight and what just landed. If a sibling touches the same files, read its PR (`gh pr list`, `bl show KEY`) and plan around it, or comment on both tickets. For more: `bl status`, `bl ls PROJ --all`, `bl log PROJ`, and the project's design doc. You see only your direct upstream results unless you look.
2. **Stay in scope.** Meet the spec's "Done when" checks.
   - Follow-up work you find goes in a new ticket: `bl add PROJ "…" -b "…" --after $BL_TICKET`.
   - If something has to happen *first*, file it with `--blocks $BL_TICKET`, then `bl release $BL_TICKET --reason "split: needs KEY"`, and stop.
   - If the spec is wrong or unclear, write a `bl comment` and `bl release` the ticket. Don't guess at large changes.
3. **Decide how to work it.** Small tickets (s/m): do them directly. Large ones (l/xl, or several independent parts): you may dispatch subagents or a short workflow inside this ticket. You hold the lease and you report; subagents never call `bl` for this ticket.
4. **Leave progress notes** between big steps: `bl comment $BL_TICKET "…"`, one line each. Leases renew automatically. During a very long single step, run `bl beat`.
5. **Code work follows the repo's rules**: your worktree (orchestrator and daemon workers start inside it; otherwise `bl worktree $BL_TICKET`), the repo's branch and PR conventions, and its checks.
   - Review policy `self` (the default everywhere): test it yourself (actually run it), rebase on main and resolve any conflicts, get the checks green, and merge your own PR as the repo allows. Nobody reviews your code for you; don't leave a PR open waiting for a human.
   - `pr` or `ask` (only where a project sets it on purpose): open the PR, get its checks green, and stop. Don't merge.
   - **A ticket is done only once its PR is merged.** Never `bl done --final` with an open PR: `bl` checks every PR linked in the result and keeps the ticket in review ("needs you") until each one is merged. Approving it in chito doesn't skip this either.
6. **Finish with exactly one** of:
   - `bl done $BL_TICKET -m "<what changed; PR url; how verified; what downstream should know>" --tldr "<for the human>"`
   - `bl fail $BL_TICKET -m "<what broke; what you tried; what to try next>" --tldr "<for the human>"`. This counts as an attempt; the ticket is retried or marked failed.
   - `-m` is for the next agent and can be long. `--tldr` is what the human sees on "Waiting on you" if this lands on them: at most 3 short sentences of plain words, or `- ` bullets (at most 6) when it needs more. Lead with what they must do or decide. Anything longer belongs in a screenshot or mock, not prose.
   - `bl release $BL_TICKET --reason "…"`. This hands the ticket back without counting an attempt.
   The `-m` text is injected into every downstream ticket's prompt, so write it for the next agent.
7. **Hard limits**: never deploy, spend money, push to main, or touch secrets unless the spec says so and the ticket isn't assigned to `human`. Don't change other tickets' state except to add new ones or comment on them.

The Stop hook blocks you from ending while `$BL_TICKET` is still `in_progress`. Report first.
