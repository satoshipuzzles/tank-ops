/**
 * One socket to one relay, with NIP-42 in front of it.
 *
 * The Buzz relay this board reads is a *private* one — its own NIP-11 document
 * calls it "private team communication relay" — and it refuses a subscription
 * before it has seen an AUTH:
 *
 *     <- ["AUTH","8a6785eb…"]
 *     <- ["NOTICE","auth-required: authenticate before subscribing"]
 *     <- ["CLOSED","board","auth-required: not authenticated"]
 *
 * That single fact settles the question I raised when this was filed. I said a
 * static page cannot enforce a whitelist, and that is still true of a page —
 * but it is not true here, because the *relay* enforces membership before it
 * hands over a single event. Nothing on this board is visible to somebody the
 * relay will not talk to. The whitelist in `src/whitelist.ts` is a second,
 * weaker thing on top: presentation and curation, and it says so.
 *
 * The signature comes from the browser extension, so this file never sees a
 * private key.
 */

export type Signer = {
  getPublicKey(): Promise<string>
  signEvent(e: {
    kind: number
    created_at: number
    tags: string[][]
    content: string
  }): Promise<{ id: string; sig: string; pubkey: string; kind: number; created_at: number; tags: string[][]; content: string }>
}

export interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export type Filter = Record<string, unknown>

/** What went wrong, in words a person can act on rather than a code. */
export class RelayError extends Error {
  constructor(
    message: string,
    /** The relay's own words, when it gave any. Worth showing verbatim. */
    readonly detail = '',
  ) {
    super(message)
  }
}

export class Relay {
  private ws: WebSocket | null = null
  private nextSub = 0
  private readonly subs = new Map<
    string,
    { onEvent: (e: NostrEvent) => void; onEose: () => void }
  >()
  private authed: Promise<void> | null = null
  private pendingOk = new Map<string, (ok: boolean, reason: string) => void>()

  constructor(
    readonly url: string,
    private readonly signer: Signer,
    /**
     * An extra tag to put on the AUTH event.
     *
     * Buzz's own agents authenticate with a delegation tag rather than by being
     * relay members themselves — an agent key on its own is refused with
     * `restricted: not a relay member`. A human's npub needs nothing here.
     */
    private readonly authTag: string[] | null = null,
  ) {}

  /** Connect and authenticate. Resolves when the relay has accepted the AUTH. */
  connect(): Promise<void> {
    if (this.authed) return this.authed
    this.authed = new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (m: string, d = '') => {
        if (settled) return
        settled = true
        reject(new RelayError(m, d))
      }
      let ws: WebSocket
      try {
        ws = new WebSocket(this.url)
      } catch (err) {
        fail('That relay URL is not one a browser can open.', String(err))
        return
      }
      this.ws = ws

      // A socket that never answers is the most common failure here and the
      // one with the least to show for itself, so it gets a deadline and a
      // sentence rather than a spinner that runs forever.
      const deadline = setTimeout(() => {
        fail('The relay did not answer in fifteen seconds.', this.url)
        ws.close()
      }, 15_000)

      ws.onerror = () => fail('Could not reach the relay.', this.url)
      ws.onclose = () => {
        clearTimeout(deadline)
        fail('The relay closed the connection before authenticating.', this.url)
      }
      ws.onmessage = async (m) => {
        let msg: unknown[]
        try {
          msg = JSON.parse(String(m.data))
        } catch {
          return
        }
        const [type] = msg as [string, ...unknown[]]

        if (type === 'AUTH') {
          const challenge = msg[1] as string
          try {
            const tags = [
              ['relay', this.url],
              ['challenge', challenge],
            ]
            if (this.authTag) tags.push(this.authTag)
            const signed = await this.signer.signEvent({
              kind: 22242,
              created_at: Math.floor(Date.now() / 1000),
              tags,
              content: '',
            })
            this.pendingOk.set(signed.id, (ok, reason) => {
              clearTimeout(deadline)
              if (!ok) {
                // The relay's own words, because "restricted: not a relay
                // member" tells somebody exactly what to do next and "login
                // failed" tells them nothing.
                fail('The relay refused this npub.', reason)
                return
              }
              settled = true
              ws.onclose = null
              resolve()
            })
            ws.send(JSON.stringify(['AUTH', signed]))
          } catch (err) {
            fail('The signing extension refused or was dismissed.', String(err))
          }
          return
        }

        if (type === 'OK') {
          const [, id, ok, reason] = msg as [string, string, boolean, string]
          this.pendingOk.get(id)?.(ok, reason ?? '')
          this.pendingOk.delete(id)
          return
        }

        if (type === 'EVENT') {
          const [, sub, event] = msg as [string, string, NostrEvent]
          this.subs.get(sub)?.onEvent(event)
          return
        }

        if (type === 'EOSE') {
          const [, sub] = msg as [string, string]
          this.subs.get(sub)?.onEose()
          return
        }

        if (type === 'CLOSED') {
          const [, sub, reason] = msg as [string, string, string]
          const s = this.subs.get(sub)
          this.subs.delete(sub)
          // A CLOSED before EOSE means the subscription produced nothing and
          // never will. Ending it rather than waiting is the difference
          // between an error and a hang.
          if (s) s.onEose()
          if (!settled) fail('The relay closed the subscription.', reason ?? '')
        }
      }
    })
    return this.authed
  }

  /**
   * One filter, everything it has, then stop.
   *
   * Bounded by EOSE rather than by a timer or a count. A count never binds —
   * it does not drop until the relay's store drops it — and a timer is a clock
   * the relay does not share.
   */
  list(filters: Filter[]): Promise<NostrEvent[]> {
    return new Promise((resolve) => {
      const sub = `s${this.nextSub++}`
      const out: NostrEvent[] = []
      const finish = () => {
        this.subs.delete(sub)
        try {
          this.ws?.send(JSON.stringify(['CLOSE', sub]))
        } catch {
          /* already gone */
        }
        resolve(out)
      }
      this.subs.set(sub, { onEvent: (e) => out.push(e), onEose: finish })
      this.ws?.send(JSON.stringify(['REQ', sub, ...filters]))
    })
  }

  /** Sign and publish. Resolves with the relay's verdict, refused or not. */
  async publish(draft: {
    kind: number
    created_at?: number
    tags: string[][]
    content: string
  }): Promise<{ ok: boolean; reason: string; event: NostrEvent }> {
    const tags = this.authTag ? [...draft.tags, this.authTag] : draft.tags
    const signed = (await this.signer.signEvent({
      kind: draft.kind,
      created_at: draft.created_at ?? Math.floor(Date.now() / 1000),
      tags,
      content: draft.content,
    })) as NostrEvent
    return new Promise((resolve) => {
      // A publish with no verdict is a different thing from a refusal — see
      // the note in the README. Ten seconds, then say which one this was.
      const timer = setTimeout(
        () => resolve({ ok: false, reason: 'no verdict from the relay', event: signed }),
        10_000,
      )
      this.pendingOk.set(signed.id, (ok, reason) => {
        clearTimeout(timer)
        resolve({ ok, reason, event: signed })
      })
      this.ws?.send(JSON.stringify(['EVENT', signed]))
    })
  }

  close(): void {
    this.ws?.close()
    this.ws = null
    this.authed = null
  }
}
