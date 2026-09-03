/**
 * Tank Ops — the Tank Arena backlog, read straight off the relay.
 *
 * Puzz: "we also need a dedicated admin tank web page hosted and deployed to
 * vercel to see all pending tasks, all completed tasks, what tasks are being
 * worked on and by who (which agent)... nostr login nip07 and whitelisted users
 * by NIP-05 and or npubs who can create tasks."
 *
 * Three columns and a compose box, over signed events and nothing else. The
 * design constraint that shaped every file here: **anything this page shows,
 * somebody else must be able to reconstruct from the same relay.** No database,
 * no cache anybody has to trust, no state that exists only because this page
 * ran. A board that knows something the relay does not is a private tracker.
 */

import './style.css'
import { Relay, RelayError, type NostrEvent, type Signer } from './relay'
import { KIND_ASSIGN, KIND_ISSUE, KIND_STATUS, assemble, isAssignOp, type Task } from './model'
import { KNOWN, resolveKnown, type Known } from './whitelist'

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T

/** The repo this board is about. Owner and identifier, NIP-34 style. */
const REPO_OWNER = '67d1464ab57158c95e593b0f6d6d5b4c3f9b626cbf2dfda1e3c69e96973dae0c'
const REPO_ID = 'nostr-tank-arena'
const REPO_A = `30617:${REPO_OWNER}:${REPO_ID}`
const DEFAULT_RELAY = 'wss://moooonboi.communities.buzz.xyz'

const relayInput = $<HTMLInputElement>('relay-url')
relayInput.value = localStorage.getItem('ops.relay') ?? DEFAULT_RELAY
$('gate-relay').textContent = relayInput.value

interface Nip07 extends Signer {
  getPublicKey(): Promise<string>
}
declare global {
  interface Window {
    nostr?: Nip07
    /** Exposed for test/board.mjs, which drives this with a stub extension. */
    __ops?: {
      relay: Relay | null
      tasks: Task[]
      load: () => Promise<void>
      known: Map<string, Known>
    }
  }
}

let relay: Relay | null = null
let tasks: Task[] = []
let me = ''
let known = new Map<string, Known>()
const profiles = new Map<string, { name?: string; picture?: string }>()

// ------------------------------------------------------------------ signing

/**
 * Sign in.
 *
 * NIP-07 only for now, and the gate says so rather than offering a button that
 * cannot work. NIP-46 belongs here for phones and televisions — where there is
 * no extension to install — and it is the next thing this page needs; pretending
 * the current build has it would be worse than the sentence admitting it does
 * not.
 */
async function signIn(): Promise<void> {
  const err = $('gate-error')
  err.hidden = true
  if (!window.nostr) {
    show(
      err,
      'No signing extension found. This page needs NIP-07 — Alby or nos2x on a desktop browser.',
    )
    return
  }
  const url = relayInput.value.trim() || DEFAULT_RELAY
  localStorage.setItem('ops.relay', url)
  try {
    me = await window.nostr.getPublicKey()
  } catch {
    show(err, 'The extension refused to hand over a public key.')
    return
  }
  relay = new Relay(url, window.nostr)
  try {
    await relay.connect()
  } catch (e) {
    const re = e as RelayError
    // Verbatim, because "restricted: not a relay member" tells somebody exactly
    // what to do next and "sign-in failed" tells them nothing at all.
    show(err, `${re.message}${re.detail ? ` — ${re.detail}` : ''}`)
    relay = null
    return
  }
  known = await resolveKnown(KNOWN)
  $('gate').hidden = true
  $('board').hidden = false
  $('login').hidden = true
  $('refresh').hidden = false
  $('new-task').hidden = false
  const w = $('who')
  w.hidden = false
  w.textContent = nameFor(me)
  await load()
}

function show(el: HTMLElement, text: string): void {
  el.textContent = text
  el.hidden = false
}

// ------------------------------------------------------------------ loading

async function load(): Promise<void> {
  if (!relay) return
  const btn = $<HTMLButtonElement>('refresh')
  btn.disabled = true
  btn.textContent = 'Reading…'
  try {
    // Two filters, one round trip. Both are bounded by EOSE rather than by a
    // count: a limit does not bind, because it never drops until the relay's
    // own retention does, and the real bound would become somebody else's
    // storage config.
    const [issues, statuses, notes] = await Promise.all([
      relay.list([{ kinds: [KIND_ISSUE], '#a': [REPO_A], limit: 500 }]),
      relay.list([{ kinds: [...KIND_STATUS], '#a': [REPO_A], limit: 800 }]),
      // Assignment ops are kind-1 notes in the CLI's shape. The `#t` narrows
      // it where the relay honours that filter; `isAssignOp` narrows it again
      // here, because a PR comment with the repo's `a` tag is also a kind 1
      // and must not become somebody's assignment.
      relay.list([
        { kinds: [KIND_ASSIGN], '#a': [REPO_A], '#t': ['assignment', 'unassignment'], limit: 800 },
      ]),
    ])
    tasks = assemble(issues, statuses, notes.filter(isAssignOp), REPO_OWNER)
    await loadProfiles(tasks)
    paint()
  } finally {
    btn.disabled = false
    btn.textContent = 'Refresh'
  }
}

/** Faces and names, fire and forget — a board with short npubs on it is still a board. */
async function loadProfiles(list: Task[]): Promise<void> {
  if (!relay) return
  const want = new Set<string>()
  for (const t of list) {
    want.add(t.author)
    if (t.workingOn) want.add(t.workingOn)
    if (t.status) want.add(t.status.pubkey)
    for (const a of t.assignees) {
      want.add(a.pubkey)
      want.add(a.by)
    }
  }
  const missing = [...want].filter((p) => !profiles.has(p))
  if (!missing.length) return
  const metas = await relay.list([{ kinds: [0], authors: missing, limit: missing.length * 2 }])
  const newest = new Map<string, NostrEvent>()
  for (const m of metas) {
    const seen = newest.get(m.pubkey)
    if (!seen || m.created_at > seen.created_at) newest.set(m.pubkey, m)
  }
  for (const [pk, ev] of newest) {
    try {
      const j = JSON.parse(ev.content) as { name?: string; display_name?: string; picture?: string }
      profiles.set(pk, { name: j.display_name || j.name, picture: j.picture })
    } catch {
      profiles.set(pk, {})
    }
  }
  for (const pk of missing) if (!profiles.has(pk)) profiles.set(pk, {})
}

// ----------------------------------------------------------------- painting

const short = (pk: string) => `${pk.slice(0, 6)}…${pk.slice(-4)}`

function nameFor(pk: string): string {
  return profiles.get(pk)?.name || known.get(pk)?.label || short(pk)
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )

function ago(seconds: number): string {
  const mins = Math.round((Date.now() / 1000 - seconds) / 60)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 36) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function paint(): void {
  const cols: Array<[string, Task[]]> = [
    ['col-wip', tasks.filter((t) => t.column === 'wip')],
    ['col-pending', tasks.filter((t) => t.column === 'pending')],
    ['col-done', tasks.filter((t) => t.column === 'done')],
  ]
  for (const [id, list] of cols) {
    const col = $(id)
    col.querySelector('.n')!.textContent = String(list.length)
    col.querySelector('.cards')!.innerHTML =
      list.map(card).join('') ||
      '<p class="fine empty">Nothing here.</p>'
  }
  const unverified = tasks.filter((t) => !known.has(t.author)).length
  $('counts').innerHTML =
    `<span><b>${tasks.length}</b> tasks</span>` +
    `<span><b>${cols[0][1].length}</b> in progress</span>` +
    `<span><b>${cols[1][1].length}</b> pending</span>` +
    `<span><b>${cols[2][1].length}</b> done</span>` +
    (unverified
      ? `<span class="warn"><b>${unverified}</b> from unrecognised npubs</span>`
      : '')
  $('board-note').textContent =
    'Every card here is a NIP-34 event on the relay. Nothing is stored by this page — ' +
    'reload it against the same relay from anywhere and you get the same board.'
}

function card(t: Task): string {
  const entry = known.get(t.author)
  const badge = entry
    ? `<span class="tag ${entry.agent ? 'agent' : 'human'}">${escapeHtml(entry.label)}</span>`
    : `<span class="tag unverified" title="Not on the board's known-authors list. Shown, not hidden — a task board that drops tasks loses them.">unverified</span>`
  const worker = t.workingOn
    ? `<div class="worker">picked up by <b>${escapeHtml(nameFor(t.workingOn))}</b></div>`
    : ''
  const closed =
    t.column === 'done' && t.status
      ? `<div class="worker">closed by <b>${escapeHtml(nameFor(t.status.pubkey))}</b> · ${ago(t.status.created_at)}</div>`
      : ''
  const labels = t.labels
    .map((l) => `<span class="label">${escapeHtml(l)}</span>`)
    .join('')
  const assignees = t.assignees.length
    ? `<div class="assignees">assigned to ${t.assignees
        .map(
          (a) =>
            `<span class="assignee${a.trusted ? '' : ' untrusted'}"${
              a.trusted
                ? ''
                : ` title="Signed by ${escapeHtml(nameFor(a.by))}, who is not the issue author or the repo owner. Buzz clients may not honour it."`
            }>${escapeHtml(nameFor(a.pubkey))}` +
            (t.column === 'done'
              ? '</span>'
              : `<button class="unassign" data-id="${t.id}" data-who="${a.pubkey}" title="Unassign ${escapeHtml(nameFor(a.pubkey))}" type="button">×</button></span>`),
        )
        .join(' ')}</div>`
    : ''
  // Anything not finished can be handed to somebody. Options come from the
  // known-authors list rather than from profiles seen so far, so a teammate
  // who has never filed anything is still assignable.
  const assign =
    t.column === 'done'
      ? ''
      : `<div class="assign-row"><select class="assign-who" data-id="${t.id}">` +
        `<option value="">Assign to…</option>` +
        [...known.entries()]
          .map(([hex, k]) => `<option value="${hex}">${escapeHtml(k.label)}${k.agent ? ' (agent)' : ''}</option>`)
          .join('') +
        `</select><button class="assign ghost tiny" data-id="${t.id}" type="button">Assign</button></div>`
  return (
    `<article class="task" data-id="${t.id}">` +
    `<h3>${escapeHtml(t.subject)}</h3>` +
    `<div class="meta">${badge}<span class="fine">${escapeHtml(nameFor(t.author))} · ${ago(t.createdAt)}</span></div>` +
    (labels ? `<div class="labels">${labels}</div>` : '') +
    worker +
    assignees +
    closed +
    `<details><summary>Detail</summary><pre>${escapeHtml(t.body.slice(0, 4000))}</pre></details>` +
    assign +
    `</article>`
  )
}

// --------------------------------------------------------------- assigning

/**
 * Publish an assignment or unassignment, in the exact shape the Buzz CLI
 * publishes — same kind, same tags — so Buzz Desktop and this board read each
 * other's ops without a translation layer to drift.
 */
async function publishAssign(taskId: string, who: string, remove: boolean): Promise<void> {
  if (!relay) return
  const label = nameFor(who)
  const verdict = await relay.publish({
    kind: KIND_ASSIGN,
    tags: [
      ['e', taskId, '', 'root'],
      ['a', REPO_A],
      ['p', who],
      ['t', remove ? 'unassignment' : 'assignment'],
    ],
    content: remove ? `Unassigned ${label} from this issue` : `Assigned this issue to ${label}`,
  })
  if (!verdict.ok) {
    // Into the counts strip, which is always on screen — a per-card error slot
    // would vanish with the repaint this triggers anyway.
    $('counts').innerHTML = `<span class="warn">The relay refused the assignment: ${escapeHtml(verdict.reason || 'no reason given')}</span>`
    return
  }
  await load()
}

document.addEventListener('click', (ev) => {
  const el = ev.target as HTMLElement
  const assignBtn = el.closest<HTMLButtonElement>('button.assign')
  if (assignBtn) {
    const id = assignBtn.dataset.id!
    const sel = document.querySelector<HTMLSelectElement>(`select.assign-who[data-id="${id}"]`)
    if (sel?.value) void publishAssign(id, sel.value, false)
    return
  }
  const unassignBtn = el.closest<HTMLButtonElement>('button.unassign')
  if (unassignBtn) void publishAssign(unassignBtn.dataset.id!, unassignBtn.dataset.who!, true)
})

// ------------------------------------------------------------------ filing

async function file(): Promise<void> {
  const err = $('c-error')
  err.hidden = true
  const subject = $<HTMLInputElement>('c-subject').value.trim()
  const body = $<HTMLTextAreaElement>('c-body').value.trim()
  const labels = $<HTMLInputElement>('c-labels')
    .value.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!subject) {
    show(err, 'A task needs a subject line.')
    return
  }
  if (!relay) {
    show(err, 'Not connected to a relay.')
    return
  }
  const verdict = await relay.publish({
    kind: KIND_ISSUE,
    tags: [
      ['a', REPO_A],
      ['p', REPO_OWNER],
      ['subject', subject],
      ...labels.map((l) => ['t', l]),
    ],
    content: body || subject,
  })
  if (!verdict.ok) {
    // The relay's verdict, unedited. "no verdict" and "refused" are different
    // failures and the difference is the first thing worth knowing.
    show(err, `The relay did not take it: ${verdict.reason || 'no reason given'}`)
    return
  }
  ;($('compose') as HTMLDialogElement).close()
  $<HTMLInputElement>('c-subject').value = ''
  $<HTMLTextAreaElement>('c-body').value = ''
  $<HTMLInputElement>('c-labels').value = ''
  await load()
}

// ------------------------------------------------------------------- wiring

$('login').addEventListener('click', () => void signIn())
$('login-2').addEventListener('click', () => void signIn())
$('refresh').addEventListener('click', () => void load())
$('new-task').addEventListener('click', () => ($('compose') as HTMLDialogElement).showModal())
$('compose').addEventListener('close', (e) => {
  const dialog = e.target as HTMLDialogElement
  if (dialog.returnValue === 'send') void file()
})

window.__ops = {
  get relay() {
    return relay
  },
  get tasks() {
    return tasks
  },
  get known() {
    return known
  },
  load,
} as Window['__ops']
