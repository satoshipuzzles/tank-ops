// The board, printed, against the real relay.
//
// The page needs a NIP-07 extension and there is none in a terminal, so this is
// the only way to check that the *live* data sorts the way the columns claim.
// It runs the same `assemble` the page runs — importing it rather than
// reimplementing it, because a second copy of the sorting rule would drift from
// the first and this would then agree with a board that was wrong.
//
//   node tools/preview.mjs

import WebSocket from 'ws'
import { finalizeEvent } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'
import { assemble } from '../src/model.ts'

const REPO_OWNER = '67d1464ab57158c95e593b0f6d6d5b4c3f9b626cbf2dfda1e3c69e96973dae0c'
const REPO_A = `30617:${REPO_OWNER}:nostr-tank-arena`
const url = process.env.BUZZ_RELAY_URL
const rawKey = process.env.BUZZ_PRIVATE_KEY
const sk = rawKey.startsWith('nsec') ? nip19.decode(rawKey).data : Uint8Array.from(Buffer.from(rawKey, 'hex'))
const authTag = process.env.BUZZ_AUTH_TAG ? JSON.parse(process.env.BUZZ_AUTH_TAG) : null

const issues = []
const statuses = []
let eose = 0
const ws = new WebSocket(url)
let done = false
const end = () => {
  if (done) return
  done = true
  const tasks = assemble(issues, statuses)
  const col = (name) => tasks.filter((t) => t.column === name)
  for (const name of ['wip', 'pending', 'done']) {
    const list = col(name)
    console.log(`\n${name.toUpperCase()} — ${list.length}`)
    for (const t of list.slice(0, 40)) {
      const who = t.workingOn ? `  <- ${t.workingOn.slice(0, 8)}` : ''
      console.log(`  ${t.subject.slice(0, 84)}${who}`)
    }
  }
  console.log(`\n${tasks.length} tasks from ${issues.length} issues and ${statuses.length} statuses`)
  ws.close()
  process.exit(0)
}

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg[0] === 'AUTH') {
    ws.send(
      JSON.stringify([
        'AUTH',
        finalizeEvent(
          {
            kind: 22242,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['relay', url], ['challenge', msg[1]], ...(authTag ? [authTag] : [])],
            content: '',
          },
          sk,
        ),
      ]),
    )
    return
  }
  if (msg[0] === 'OK') {
    if (!msg[2]) {
      console.error('relay refused the AUTH:', msg[3])
      process.exit(3)
    }
    ws.send(JSON.stringify(['REQ', 'i', { kinds: [1621], '#a': [REPO_A], limit: 500 }]))
    ws.send(JSON.stringify(['REQ', 's', { kinds: [1630, 1631, 1632, 1633], '#a': [REPO_A], limit: 800 }]))
    return
  }
  if (msg[0] === 'EVENT') {
    if (msg[2].kind === 1621) issues.push(msg[2])
    else statuses.push(msg[2])
    return
  }
  if (msg[0] === 'EOSE') {
    eose++
    if (eose >= 2) end()
  }
  if (msg[0] === 'CLOSED') {
    console.error('closed:', msg[2])
    process.exit(2)
  }
})
ws.on('error', (e) => {
  console.error('relay error', e.message)
  process.exit(2)
})
setTimeout(end, 20_000)
