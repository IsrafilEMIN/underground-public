# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `docs/SPEC.md`. It is not a board card and has no `**Closed:**` line, so **close spec** does not apply: the spec is done when its last ticket closes
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Triage state is the `**Role:**` line near the top of the ticket file (see `triage-labels.md` for the role strings). A ticket is closed when its `**Closed:**` line says `yes`. The card's lane follows from them (see [Board](#board)).
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed), then apply the board **Add** operation (see [Board](#board)).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`. It starts with `# NN: <title>`, then the field lines (see **Fields** below): `**Type:**` (`research`/`prototype`/`grilling`/`task`), `**Closed:** no`, `**Priority:** NN` and `**Blocked by:**`. The question goes under `## Question`. `**Closed:** yes` records resolved; the pushed work branch records the claim.
- **Blocking**: a `**Blocked by:** NN, NN` line near the top. A ticket is unblocked when every ticket it lists is closed. `board.sh` reads only the bold field names, so a plain `Type:` or `Blocked by:` line is not a field.
- **Frontier**: the cards in `Todo` tagged `#<effort>`; the first one on the board wins.
- **Claim**: create and push the ticket's work branch before any work. The card does not move.
- **Resolve**: append the answer under an `## Answer` heading, apply the board **Resolve** operation, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.

## Board

`TODO.md` at the repo root is this repo's Tern board. Tern reads `##` headings as lanes and `- [ ]` items as cards, writes every change to the file at once, and shows edits from other programs live. Git tracks `TODO.md`, and the copy on `main` is the only board. A card change goes in the same branch and PR as the work that causes it, and reaches `main` only after that PR's checks pass and the merge is verified. Nobody commits `TODO.md` straight to `main`, and an edit made in Tern goes through a PR too. When a skill changes a ticket's state, it also applies the matching board operation below, in that branch. If no work branch exists, for example for a ticket published outside a PR, open a branch and PR for the board change alone.

The ticket file is the source of truth; the card mirrors it. A card holds only its title, its tags and one note line. Every detail lives in the ticket file. Ticket files carry no `Status:` line.

The board is generated. The `pre-setup` skill's `scripts/board.sh build` writes `TODO.md` from the ticket files, so nobody edits `TODO.md` by hand. To change a card, change its ticket and run the script. Run it from the repo root, then run the same script with `check`; it must print `ok` before each commit that touches `.scratch/`. A merge conflict in `TODO.md` is fixed by running the script again.

- **Fields**: each ticket file holds its field lines between its `# <NN>: <title>` heading and its first `##` heading: `**Role:**` (the triage role), `**Closed:**` (`yes` or `no`), `**Priority:**` (a number), `**Blocked by:**`, and `**Due:**` (a real date, `YYYY-MM-DD`) when the ticket has one. A wayfinder ticket has `**Type:**` in place of `**Role:**`. `**Role:**` is required only when `docs/agents/triage-labels.md` exists. `**Blocked by:**` holds two-digit numbers (`01, 02`), `<feature-slug> NN` for another feature, or `none`; a note in parentheses after a number is allowed. Any other bold `**Name:**` line, or a field given twice, before the first `##` heading fails the board check: body text goes under a `##` heading. A spec has no role and no number; its heading is its card title.
- **Order**: in each lane, cards go by `**Priority:**`, lowest number first; a tie goes by feature slug, then number. A card whose blocker is in the same lane goes below that blocker. To move a card up, give it a lower number.
- **Lanes**: `## Backlog`, `## Todo`, `## Done`, in that order. If a lane is missing, add it.
- **Card**: `- [ ] <NN>: <title> #<feature-slug>` (the title is the ticket's heading, with a capital first letter; a `#` in it shows as `＃`, so Tern does not read it as a tag), then `#<role>` when triage labels are configured, `#<type>` for a wayfinder ticket, `#spec` for a spec, and `📅 YYYY-MM-DD` only when the ticket has a due date. Under the card, one indented note line: `<path to the ticket file> · blocked by: <open refs, or none>`. The note lists only the blockers that are still open, in the ticket's order, and says `none` once all of them are closed. The ticket's own `**Blocked by:**` line is history: it keeps every blocker and is never rewritten. `<feature-slug>` is the `.scratch/` directory name. `board.sh build` writes `TODO.md` in one step, and only when the board changed, so an open Tern board never reads a half-written file.
- **Ready**: a ticket is ready when it is open, nobody has claimed it, and every ticket that blocks it is closed. If `docs/agents/triage-labels.md` exists, its role must also be `ready-for-agent` or `ready-for-human`. Wayfinder tickets carry a type, not a triage role, so the role condition does not apply to them. A `#spec` card is never ready: it stays in `Backlog` until it is resolved.
- **Claimed**: a ticket is claimed while a pushed branch or an open PR does its work, or while it has an assignee in a tracker that has assignees. The board never shows a claim: a lane on `main` shows only a state that passed the pipeline.
- **Lane rule**: `Done` if the ticket is closed; else `Todo` if it is ready; else `Backlog`. A claim does not move the card.
- **Done is always ticked**: Tern marks every card in `Done` as done. A ticket closed without the work (`wontfix`, out of scope) goes to `Done` ticked, with a `#wontfix` tag.

Operations:

- **Add** (a ticket or spec is published): in the branch that publishes it, write the ticket with its fields and run the script.
- **Resolve** (the ticket closes): in the branch that does the work, set `**Closed:** yes` and run the script. It ticks the card, moves it to `Done`, drops this ticket from the note of each card it blocked, and moves each card it unblocked.
- **Change role**: change the `**Role:**` line and run the script.
- **Worktrees**: each branch edits only its own tickets. If two PRs conflict on `TODO.md`, the later one rebases on `main`, runs the script in place of a hand merge, and passes its checks again before it merges.
