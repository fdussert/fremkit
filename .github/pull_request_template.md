## What this changes

<!-- One or two sentences: what the patch does, and why it is worth doing. -->

## How to see it

<!-- The steps you ran, or the screen to look at. For a widget, say which one and on which screen.
     A screenshot helps for anything visible. -->

## Checks

- [ ] `pnpm typecheck` and `pnpm test` pass
- [ ] `pnpm --filter ui build` run, if the UI changed
- [ ] the widgets rescanned (the ⟳ in the admin's widget library, or a `curl` with the access secret: see AGENTS.md), if a manifest changed
- [ ] user-facing strings are there in French **and** English
- [ ] nothing personal anywhere — hostname, IP, organisation, serial number, e-mail, token — tests and fixtures included
