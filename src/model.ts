/**
 * Issues and their state, assembled from signed events and nothing else.
 *
 * There is no database behind this board. Every column is derived from events
 * anybody with relay access can fetch for themselves, which is the property
 * worth protecting: if this page showed you something you could not reconstruct
 * from the same relay, it would be a private tracker wearing an open protocol
 * as a coat.
 */

import type { NostrEvent } from './relay'

/** NIP-34 kinds this board reads. */
export const KIND_REPO = 30617
export const KIND_ISSUE = 1621
/** Status: open, applied/resolved, closed, draft — in that order. */
export const KIND_STATUS = [1630, 1631, 1632, 1633] as const
/**
 * Assignment operations are kind-1 notes, because that is what the Buzz CLI
 * publishes — checked against a real op on the relay, not guessed:
 *
 *     kind 1
 *     ["e", <issue-id>, "", "root"]
 *     ["a", <repo a-tag>]
 *     ["p", <assignee>]          // absent on a self-assign; the signer is it
 *     ["t", "assignment"]        // or "unassignment" to take it back off
 *
 * The Buzz clients' trust rule, from the CLI's own help: an op is trusted for
 * *other* people only when the issue author or the repo owner signed it, and
 * anybody may assign or unassign themselves. This board applies the same rule
 * so the two never show different assignee rails — and shows untrusted ops
 * anyway, marked, for the same reason unverified authors are shown: a board
 * that silently drops a signed statement loses it.
 */
export const KIND_ASSIGN = 1

export type Column = 'pending' | 'wip' | 'done' | 'draft'

export interface Task {
  id: string
  author: string
  createdAt: number
  subject: string
  body: string
  labels: string[]
  column: Column
  /**
   * The status event that decided the column, if any.
   *
   * Held rather than flattened because *who signed it* is the answer to "who is
   * working on this" — a name in a body is a claim, a signature is not.
   */
  status: NostrEvent | null
  /** Whoever signed the most recent `wip` status. Null when nobody has. */
  workingOn: string | null
  /** Current assignees, latest op per person winning. */
  assignees: Assignee[]
}

export interface Assignee {
  pubkey: string
  /**
   * Whether the op that put them here passes the Buzz trust rule: signed by
   * the issue author, the repo owner, or the assignee themselves. An untrusted
   * assignee is still listed — marked, not hidden.
   */
  trusted: boolean
  /** Who signed the winning op, for the card to say so. */
  by: string
}

const tag = (e: NostrEvent, name: string): string | null =>
  e.tags.find((t) => t[0] === name)?.[1] ?? null

const tags = (e: NostrEvent, name: string): string[] =>
  e.tags.filter((t) => t[0] === name).map((t) => t[1])

/**
 * Which issue a status event is about.
 *
 * The root `e` tag, and *only* a marked root. A status event also carries the
 * repo's `a` tag and may carry other `e` tags; taking the first `e` would sort
 * some of them onto the wrong issue, and a task board that quietly files a
 * closure against the wrong task is worse than one that files nothing.
 */
export function statusTarget(e: NostrEvent): string | null {
  const root = e.tags.find((t) => t[0] === 'e' && t[3] === 'root')
  if (root) return root[1]
  const only = e.tags.filter((t) => t[0] === 'e')
  return only.length === 1 ? only[0][1] : null
}

/**
 * `wip` is a convention, not a kind.
 *
 * Nothing in NIP-34 says "somebody has started on this", and inventing a kind
 * for it would be inventing a protocol nobody else implements. An *open* status
 * (1630) carrying a `t` tag of `wip` says it with what already exists, and the
 * answer to "who" falls out for free: it is whoever signed that event. No new
 * trust, no label to be believed.
 */
export const isWip = (e: NostrEvent): boolean =>
  e.kind === 1630 && tags(e, 't').includes('wip')

/** An assignment or unassignment op, in the CLI's shape. */
export const isAssignOp = (e: NostrEvent): boolean => {
  if (e.kind !== KIND_ASSIGN) return false
  const t = tags(e, 't')
  return t.includes('assignment') || t.includes('unassignment')
}

/**
 * Who an op is about. The `p` tags name the assignees; a self-assign from the
 * CLI carries no `p` at all, in which case the signer is the assignee.
 */
const opAssignees = (e: NostrEvent): string[] => {
  const p = tags(e, 'p')
  return p.length ? p : [e.pubkey]
}

/** Build the board. Latest status per issue wins; no status means pending. */
export function assemble(
  issues: NostrEvent[],
  statuses: NostrEvent[],
  assignOps: NostrEvent[] = [],
  repoOwner = '',
): Task[] {
  const latest = new Map<string, NostrEvent>()
  const latestWip = new Map<string, NostrEvent>()
  for (const s of statuses) {
    const target = statusTarget(s)
    if (!target) continue
    const seen = latest.get(target)
    // Ties broken by id so two clients reading the same events in a different
    // order still build the same board. `created_at` is a second, and two
    // status events a second apart is not a hypothetical on a busy day.
    if (!seen || s.created_at > seen.created_at || (s.created_at === seen.created_at && s.id > seen.id))
      latest.set(target, s)
    if (isWip(s)) {
      const w = latestWip.get(target)
      if (!w || s.created_at > w.created_at) latestWip.set(target, s)
    }
  }

  // Latest op per (issue, assignee) wins, the same tie-break as statuses. An
  // `unassignment` winning means the seat is empty again.
  const opsByIssue = new Map<string, Map<string, NostrEvent>>()
  for (const op of assignOps) {
    if (!isAssignOp(op)) continue
    const target = statusTarget(op)
    if (!target) continue
    const perIssue = opsByIssue.get(target) ?? new Map<string, NostrEvent>()
    opsByIssue.set(target, perIssue)
    for (const who of opAssignees(op)) {
      const seen = perIssue.get(who)
      if (!seen || op.created_at > seen.created_at || (op.created_at === seen.created_at && op.id > seen.id))
        perIssue.set(who, op)
    }
  }

  const byId = new Map<string, NostrEvent>()
  for (const i of issues) if (!byId.has(i.id)) byId.set(i.id, i)

  const out: Task[] = []
  for (const issue of byId.values()) {
    const status = latest.get(issue.id) ?? null
    const wip = latestWip.get(issue.id) ?? null
    const assignees: Assignee[] = []
    for (const [who, op] of opsByIssue.get(issue.id) ?? []) {
      if (!tags(op, 't').includes('assignment')) continue
      assignees.push({
        pubkey: who,
        trusted: op.pubkey === issue.pubkey || op.pubkey === repoOwner || op.pubkey === who,
        by: op.pubkey,
      })
    }
    let column: Column = 'pending'
    if (status) {
      if (status.kind === 1631 || status.kind === 1632) column = 'done'
      else if (status.kind === 1633) column = 'draft'
      else column = isWip(status) ? 'wip' : 'pending'
    }
    out.push({
      id: issue.id,
      author: issue.pubkey,
      createdAt: issue.created_at,
      subject: tag(issue, 'subject') ?? firstLine(issue.content),
      body: issue.content,
      labels: tags(issue, 't'),
      column,
      status,
      // Only while it is still in the WIP column. Somebody who picked a task up
      // and then closed it is not working on it, and a board that still says
      // they are sends people to ask them about finished work.
      workingOn: column === 'wip' ? (wip?.pubkey ?? status?.pubkey ?? null) : null,
      assignees,
    })
  }
  // Newest first inside a column: a backlog read top-down should start with
  // what somebody just said, not with what has been sitting there since March.
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
}

function firstLine(s: string): string {
  const line = (s.split('\n').find((l) => l.trim()) ?? '').trim()
  return line.length > 90 ? line.slice(0, 88) + '…' : line || '(no subject)'
}
