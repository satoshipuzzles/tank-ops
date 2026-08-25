/**
 * Who this board treats as a known author.
 *
 * Read the caveat before adding anybody, because it changes what this list is.
 *
 * **This list does not gate anything.** Nostr has no way for a static page to
 * stop somebody publishing a kind 1621 to a relay it does not run, and neither
 * has this one. What actually refuses a write here is the relay: Buzz's relay
 * demands NIP-42 and answers `restricted: not a relay member` to an npub it
 * does not know, before it hands over a single event. That is a real gate, it
 * belongs to the relay operator, and this file is not it.
 *
 * So this list is **presentation**: an issue from somebody on it is filed under
 * their name, and an issue from anybody else is shown with an *unverified*
 * mark rather than hidden. Hiding would be the worse choice — a task board that
 * silently drops tasks is a task board that loses them, and "we could not place
 * this author" is information rather than a reason to discard a bug report.
 *
 * NIP-05 entries are checked against `/.well-known/nostr.json` at load, because
 * a `nip05` string sitting in somebody's profile is a *claim*. The domain has
 * to agree, or it is a name somebody typed about themselves.
 */

export interface Known {
  /** hex pubkey, or a `name@domain` NIP-05 that resolves to one */
  id: string
  /** What to call them on the board when their profile has not arrived yet. */
  label: string
  /** Agents get a different mark: useful to know who is a person. */
  agent?: boolean
}

export const KNOWN: Known[] = [
  {
    id: 'ab07fadfc85caa90eeae7e235c2d5940a0690e33cdd13c65223ee3187d661f04',
    label: 'Puzz',
  },
  {
    id: '67d1464ab57158c95e593b0f6d6d5b4c3f9b626cbf2dfda1e3c69e96973dae0c',
    label: 'Splitscreen',
    agent: true,
  },
  {
    id: 'ec2d4a3599d7ed0a9c7d6349d29774483fd1ddd0bce7ae41f7cc4c02c936cf57',
    label: 'cloudfodder',
  },
]

const HEX = /^[0-9a-f]{64}$/

/**
 * Resolve the list to hex pubkeys, verifying every NIP-05 for real.
 *
 * A failure to resolve is *not* a failure to load the board: the entry is
 * dropped, its owner shows as unverified, and the reason goes to the console.
 * A well-known file being down is not a reason for a backlog to be unreadable.
 */
export async function resolveKnown(list: Known[] = KNOWN): Promise<Map<string, Known>> {
  const out = new Map<string, Known>()
  await Promise.all(
    list.map(async (entry) => {
      if (HEX.test(entry.id)) {
        out.set(entry.id, entry)
        return
      }
      const [name, domain] = entry.id.split('@')
      if (!name || !domain) return
      try {
        const res = await fetch(
          `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`,
        )
        if (!res.ok) return
        const json = (await res.json()) as { names?: Record<string, string> }
        const hex = json.names?.[name]
        // The domain has to name a pubkey. Anything else — a 200 with an empty
        // body, a name that is not there — is not a verification.
        if (hex && HEX.test(hex)) out.set(hex, entry)
      } catch (err) {
        console.warn(`nip-05 lookup failed for ${entry.id}`, err)
      }
    }),
  )
  return out
}
