# `public/creative-login/` — provenance

These two files are **byte-identical copies** of the owner's reference demo in
`Creative Login Form/` (SHA-256 verified at integration time):

| File | SHA-256 (first 16) | Role |
|---|---|---|
| `script.js` | `5EADF8CF1B98119D` | the demo's GSAP animation timeline (verbatim, unmodified) |
| `style.css` | `2F4F4854308A4704` | the demo's form styling (verbatim, unmodified) |

They are served from the app's own origin and animated by the **`gsap` npm
dependency (pinned 3.13.0)**, not by the demo's
`<script src="https://unpkg.com/gsap@3/dist/gsap.min.js">`. That CDN tag was
removed on purpose: remote script on our origin is a supply-chain risk and
breaks the tool offline. `components/creative-login-form.tsx` loads these two
files after mount and provides `window.gsap` first.

The original demo folder is left untouched as the reference copy. If the
animation is ever edited here, it is no longer verbatim — say so in this file.

## `activate-on-email.js` — ours, not the demo's

This third file is **not** from the demo and is not a copy of anything. It was
written for this app because the demo only spins its gear train (which drives
the spray that reveals the submit button) when its optional "name" field looks
filled. An operator who types an e-mail and a password would otherwise never see
the submit button animate.

It drives the demo's own timelines from the e-mail field instead. The demo
declares `gearsTls`, `sprayRepeatCounter` and `submitBtn` at the top level of a
classic script, so they live in the global lexical scope and can be reached from
a script loaded afterwards — no line of `script.js` had to change.

It authenticates nothing; it only moves the artwork.

## Licensing status (recorded, not assumed)

Facts verified on 2026-10-15 by inspecting this repository — nothing here is
inferred:

- `script.js` and `style.css` come from `Creative Login Form/` **in this same
  repository**, i.e. the owner's own demo folder, which is left untouched as
  the reference copy. They are byte-identical to it (SHA-256 asserted by
  `tests/creative_login.test.ts`).
- **No licence file exists anywhere in this repository** — not for the project
  and not for the asset (searched, excluding `node_modules`/`.next`). There is
  therefore no third-party licence text to comply with, and equally no positive
  grant recorded for the asset.
- The animation runs on the pinned npm dependency **`gsap` 3.13.0**, whose own
  `package.json` declares: `Standard 'no charge' license:
  https://gsap.com/standard-license`. That licence is satisfied by local,
  internal, non-resold use; it restricts redistribution and some commercial
  uses of the library itself.
- The application is local-only and single-operator, and nothing here is
  distributed or deployed externally.

**Owner action still open (F15):** confirm that `Creative Login Form/` is
work you own or otherwise have the right to bundle. If it was ever obtained
from a third party, record that licence here before this tool is ever shown to
anyone outside the team. No file in this folder may be deleted, moved or
edited on the strength of this note — provenance decisions belong to the owner.