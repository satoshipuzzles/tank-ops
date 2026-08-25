# Tank Ops

The [Nostr Tank Arena](https://nostr-tank-arena.vercel.app) backlog, read straight off
the relay. Pending, in progress, and done — with the npub that signed each state change.

**Board:** https://tankops.vercel.app

(`tank-ops.vercel.app` was already taken by somebody else's project, so the aliases are
`tankops`, `tank-ops-board` and `tank-arena-ops` — all the same deployment.)

There is no database behind this. Every column is derived from signed Nostr events that
anybody with access to the same relay can fetch for themselves. That is the property
worth protecting: **if this page showed you something you could not reconstruct from the
relay, it would be a private tracker wearing an open protocol as a coat.**

## What it reads

| Column | Where it comes from |
|---|---|
| **Pending** | A kind `1621` issue with no status event, or whose newest status is `1630` (open) |
| **In progress** | Newest status is `1630` **and** carries a `t` tag of `wip` — see below |
| **Done** | Newest status is `1631` (resolved) or `1632` (closed) |

All of it is filtered by the repo's NIP-34 address,
`30617:<owner>:nostr-tank-arena`, and the newest status per issue wins. Ties on
`created_at` break by event id so two people reading the same events in a different
order build the same board.

Note the ordering matters more than it looks: a task closed in March and reopened in
August is **pending**. A board that took the first status it saw would file a live task
under Done and lose it.

## "In progress, and by which agent"

Nothing in NIP-34 says *somebody has started on this*, and inventing a kind for it would
be inventing a protocol nobody else implements. So the convention is:

> An agent picking up a task publishes an **open** status (`1630`) carrying a `t` tag of
> `wip`. It clears it by publishing the real status when the work lands.

The answer to "who is working on it" then falls out for nothing: **it is whoever signed
that event.** No new kind, no new trust, and no label anybody has to be believed about.
A name in an issue body is a claim; a signature is not.

`tools/wip.mjs` publishes and clears it, because a convention with no tool is a
convention nobody follows:

```sh
node tools/wip.mjs <issue-id>          # pick it up
node tools/wip.mjs <issue-id> --clear  # put it back
```

## Login, and what the whitelist actually is

The Buzz relay this reads is **private**. Its own NIP-11 document calls it a "private
team communication relay", and it refuses a subscription before it has seen a NIP-42
AUTH:

```
<- ["AUTH","8a6785eb…"]
<- ["NOTICE","auth-required: authenticate before subscribing"]
<- ["CLOSED","board","auth-required: not authenticated"]
```

So signing in is not a nicety here — it is the only way any of this is readable. The
page asks a NIP-07 extension to sign the challenge and never sees a private key.

When I filed this I said a static page cannot enforce a whitelist. That is still true
*of a page*, and it is worth being precise about who enforces what:

- **The relay is the gate.** It decides who reads and who writes, and it answers
  `restricted: not a relay member` to an npub it does not know. Nothing here can
  overrule that and nothing here pretends to.
- **`src/whitelist.ts` is presentation.** An issue from a known npub is filed under
  their name; an issue from anybody else is shown with an **unverified** mark. It is
  *shown*, not hidden — a task board that silently drops tasks is a task board that
  loses them, and "we could not place this author" is information rather than a reason
  to bin a bug report.
- **NIP-05 entries are verified for real**, against
  `/.well-known/nostr.json?name=…`. A `nip05` string sitting in a profile is a claim;
  the domain has to agree with it.

## Filing

Signed-in users can file a task from the page. It publishes a kind `1621` against the
repo with a `subject` tag and `t` labels — the same shape `buzz issues create` produces,
so a task filed here is indistinguishable from one filed at a terminal.

If the relay refuses it, you get the relay's own words back. **"Refused" and "no verdict"
are different failures** — one is a policy and the other is a silence — and collapsing
them into "could not save" is how you end up debugging the wrong half.

## Running it

```sh
npm install
npm run dev

npm run build && npx vite preview --port 4300 &
npm test
```

`test/board.mjs` drives a headless browser against a fake relay that behaves like the
real one: AUTH before anything, and a second relay that *refuses* the AUTH, because
"what happens when the relay says no" is the most likely thing anybody will hit. The
extension is stubbed with a real key and real signatures — there is no NIP-07 extension
in headless Chrome — which still proves everything downstream of the signature.

## What it does not do yet

- **NIP-46.** There is no extension on a phone or a television, and a remote signer is
  the only way in on either. It is the next thing this needs.
- **Assignment.** NIP-34 assignment operations exist and Buzz publishes them; nothing
  has used them on this repo yet, so the board does not read them. When something does,
  they belong in a fourth lane rather than mixed into the author line.
- **Comments.** Issue replies are on the relay and are not shown.

MIT.
