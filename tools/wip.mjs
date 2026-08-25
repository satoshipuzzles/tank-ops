// Pick a task up, or put it back.
//
// The board's "In progress" column reads an **open** status (kind 1630) carrying
// a `t` tag of `wip`, and answers "who" with whoever signed it. `buzz issues
// status` cannot attach a `t` tag, so this publishes the event directly — which
// is the point rather than a workaround: a convention with no tool is a
// convention nobody follows, and a column nothing can fill is a column that
// reads as "nobody is working on anything" forever.
//
//   node tools/wip.mjs <issue-id>            # pick it up
//   node tools/wip.mjs <issue-id> --clear    # put it back down
//
// Needs BUZZ_RELAY_URL, BUZZ_PRIVATE_KEY, and — for an agent key, which is not
// itself a relay member — BUZZ_AUTH_TAG.

import WebSocket from 'ws'
import { finalizeEvent } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'

const REPO_OWNER = '67d1464ab57158c95e593b0f6d6d5b4c3f9b626cbf2dfda1e3c69e96973dae0c'
const REPO_ID = 'nostr-tank-arena'
const REPO_A = `30617:${REPO_OWNER}:${REPO_ID}`

const [issueId, ...flags] = process.argv.slice(2)
const clear = flags.includes('--clear')

if (!/^[0-9a-f]{64}$/.test(issueId ?? '')) {
  console.error('usage: node tools/wip.mjs <issue-id-hex> [--clear]')
  process.exit(1)
}

const url = process.env.BUZZ_RELAY_URL
const rawKey = process.env.BUZZ_PRIVATE_KEY
if (!url || !rawKey) {
  console.error('BUZZ_RELAY_URL and BUZZ_PRIVATE_KEY are required')
  process.exit(1)
}
const sk = rawKey.startsWith('nsec') ? nip19.decode(rawKey).data : Uint8Array.from(Buffer.from(rawKey, 'hex'))
const authTag = process.env.BUZZ_AUTH_TAG ? JSON.parse(process.env.BUZZ_AUTH_TAG) : null

const draft = {
  kind: 1630,
  created_at: Math.floor(Date.now() / 1000),
  tags: [
    ['e', issueId, '', 'root'],
    ['a', REPO_A],
    ['p', REPO_OWNER],
    // The marker. Absent on `--clear`, which is what puts the task back in
    // Pending — the status is still "open", it is just nobody's any more.
    ...(clear ? [] : [['t', 'wip']]),
    ...(authTag ? [authTag] : []),
  ],
  content: clear ? 'put back — nobody is working on this' : 'picked up',
}

/**
 * `--clear` has to look before it publishes.
 *
 * I reopened a task with this within an hour of shipping it. Clearing the
 * marker publishes an *open* status, and an open status published after a
 * resolve is newer than the resolve — so a finished task walked back into
 * Pending. The board was right; the tool was wrong.
 *
 * Finishing a task is the *resolve*, which clears the marker by being newer.
 * `--clear` is only for putting a task back down, so it refuses to run against
 * one that is already closed rather than quietly undoing it.
 */
function newestStatus(ws, issueId) {
  return new Promise((resolve) => {
    let newest = null
    const sub = 'peek'
    const onMessage = (raw) => {
      const m = JSON.parse(raw.toString())
      if (m[0] === 'EVENT' && m[1] === sub) {
        const e = m[2]
        const root = e.tags.find((t) => t[0] === 'e' && t[3] === 'root')?.[1]
        if (root === issueId && (!newest || e.created_at > newest.created_at)) newest = e
        return
      }
      if ((m[0] === 'EOSE' || m[0] === 'CLOSED') && m[1] === sub) {
        ws.off('message', onMessage)
        ws.send(JSON.stringify(['CLOSE', sub]))
        resolve(newest)
      }
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify(['REQ', sub, { kinds: [1630, 1631, 1632, 1633], '#e': [issueId], limit: 50 }]))
  })
}

const event = finalizeEvent(draft, sk)
const ws = new WebSocket(url)
let done = false
const end = (code, msg) => {
  if (done) return
  done = true
  console.log(msg)
  ws.close()
  process.exit(code)
}

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg[0] === 'AUTH') {
    const auth = finalizeEvent(
      {
        kind: 22242,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['relay', url], ['challenge', msg[1]], ...(authTag ? [authTag] : [])],
        content: '',
      },
      sk,
    )
    ws.send(JSON.stringify(['AUTH', auth]))
    return
  }
  if (msg[0] === 'OK') {
    if (msg[1] === event.id) {
      // The relay's verdict verbatim. A refusal is a policy and a silence is
      // not, and this exits differently for each so a script can tell.
      return msg[2]
        ? end(0, `${clear ? 'cleared' : 'picked up'} ${issueId.slice(0, 12)}… as ${event.pubkey.slice(0, 12)}…`)
        : end(2, `relay refused: ${msg[3] || 'no reason given'}`)
    }
    if (!msg[2]) return end(3, `relay refused the AUTH: ${msg[3] || 'no reason given'}`)
    if (!clear) {
      ws.send(JSON.stringify(['EVENT', event]))
      return
    }
    newestStatus(ws, issueId).then((newest) => {
      if (newest && (newest.kind === 1631 || newest.kind === 1632)) {
        return end(
          1,
          `refusing: ${issueId.slice(0, 12)}… is already ${newest.kind === 1631 ? 'resolved' : 'closed'}. ` +
            'Clearing the marker would publish an open status newer than that and reopen it. ' +
            'Finishing a task is the resolve; it clears the marker by being newer.',
        )
      }
      ws.send(JSON.stringify(['EVENT', event]))
    })
  }
})
ws.on('error', (e) => end(2, `could not reach ${url}: ${e.message}`))
setTimeout(() => end(2, 'no verdict from the relay in fifteen seconds'), 15_000)
