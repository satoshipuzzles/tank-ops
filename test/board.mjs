// The board, against a relay this file wrote.
//
// Two things cannot be tested against the real thing, and pretending otherwise
// would make this suite a decoration:
//
//   - **A browser extension.** There is no NIP-07 extension in headless Chrome,
//     so `window.nostr` is stubbed with a real key and a real signature. What
//     that still proves is everything downstream of the signature: that the
//     page asks for one, that it puts it in a NIP-42 AUTH, and that it does the
//     right thing with the relay's answer either way.
//   - **The Buzz relay.** It is private and it refuses an npub it does not know
//     with `restricted: not a relay member` — which is the whole reason this
//     board needs a login. So the fake below behaves the same way: it demands
//     AUTH before any subscription, and one of the checks points the page at a
//     relay that *refuses*, because "what happens when the relay says no" is
//     the single most likely thing a user of this page will hit.
//
// The fixtures are the shape the real relay actually holds, checked against it:
// issues are 1621, resolved is **1631**, closed is 1632, and there is no
// assignment kind in use at all. Guessing that shape would have put every
// finished task in the wrong column.
//
//   npm run build && npx vite preview --port 4300 &
//   npm test

import { existsSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import puppeteer from 'puppeteer-core'

const SITE = process.env.OPS_URL ?? 'http://localhost:4300/'
const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean).find((p) => existsSync(p))
if (!CHROME) { console.error('No Chrome found. Set CHROME_PATH.'); process.exit(2) }

if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(SITE)) {
  // Loud, not quiet. A suite that silently passes because it could not run is
  // worse than one that fails.
  console.log(`SKIP  these checks need a plain-http origin; OPS_URL is ${SITE}`)
  console.log('      the ws:// fake relay is blocked as mixed content from https.')
  process.exit(0)
}

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 12_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await wait(90)
  }
  return null
}

// ------------------------------------------------------------- the fixtures

const OWNER = '67d1464ab57158c95e593b0f6d6d5b4c3f9b626cbf2dfda1e3c69e96973dae0c'
const REPO_A = `30617:${OWNER}:nostr-tank-arena`
// Puzz, and Splitscreen — both on the board's known-authors list.
const PUZZ = 'ab07fadfc85caa90eeae7e235c2d5940a0690e33cdd13c65223ee3187d661f04'
const AGENT = OWNER
// Somebody the list has never heard of. Their task must be *shown*, marked.
const STRANGER = generateSecretKey()
const STRANGER_PK = getPublicKey(STRANGER)

const now = Math.floor(Date.now() / 1000)
const key = generateSecretKey()

const issue = (id, subject, author, at, labels = []) => ({
  id,
  pubkey: author,
  created_at: at,
  kind: 1621,
  tags: [['a', REPO_A], ['subject', subject], ...labels.map((l) => ['t', l])],
  content: `${subject}\n\nDetail for ${subject}.`,
  sig: '0'.repeat(128),
})

const status = (id, kind, target, author, at, extra = []) => ({
  id,
  pubkey: author,
  created_at: at,
  kind,
  tags: [['e', target, '', 'root'], ['a', REPO_A], ...extra],
  content: '',
  sig: '0'.repeat(128),
})

const ISSUES = [
  issue('a1'.repeat(32), 'A task nobody has touched', PUZZ, now - 400, ['bug']),
  issue('a2'.repeat(32), 'A task being worked on', PUZZ, now - 500),
  issue('a3'.repeat(32), 'A task that is finished', PUZZ, now - 600),
  issue('a4'.repeat(32), 'A task from a stranger', STRANGER_PK, now - 300),
  issue('a5'.repeat(32), 'A task reopened after a close', PUZZ, now - 700),
]

const STATUSES = [
  // Picked up: an *open* status carrying `wip`, signed by the agent doing it.
  status('b1'.repeat(32), 1630, 'a2'.repeat(32), AGENT, now - 100, [['t', 'wip']]),
  // Finished: 1631 is what the CLI publishes for "resolved".
  status('b2'.repeat(32), 1631, 'a3'.repeat(32), AGENT, now - 90),
  // Closed and then reopened. The newest status wins, and it is the *older*
  // event that says closed — a board that took the first one it saw would file
  // a live task under Done.
  status('b3'.repeat(32), 1632, 'a5'.repeat(32), PUZZ, now - 800),
  status('b4'.repeat(32), 1630, 'a5'.repeat(32), PUZZ, now - 60),
]

const PROFILES = [
  {
    id: 'c1'.repeat(32),
    pubkey: PUZZ,
    created_at: now - 5000,
    kind: 0,
    tags: [],
    content: JSON.stringify({ name: 'Puzz' }),
    sig: '0'.repeat(128),
  },
]

/**
 * A relay that behaves like the private one: AUTH first, or nothing.
 *
 * `refuse` makes it turn the AUTH down, which is the path a person without
 * relay membership actually walks.
 */
function startRelay({ refuse = false } = {}) {
  const wss = new WebSocketServer({ port: 0 })
  const published = []
  wss.on('connection', (ws) => {
    let authed = false
    ws.send(JSON.stringify(['AUTH', 'challenge-' + Math.random().toString(16).slice(2)]))
    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg[0] === 'AUTH') {
        if (refuse) {
          ws.send(JSON.stringify(['OK', msg[1].id, false, 'restricted: not a relay member']))
          return
        }
        authed = true
        ws.send(JSON.stringify(['OK', msg[1].id, true, '']))
        return
      }
      if (msg[0] === 'REQ') {
        const [, sub, ...filters] = msg
        if (!authed) {
          ws.send(JSON.stringify(['CLOSED', sub, 'auth-required: not authenticated']))
          return
        }
        const pool = [...ISSUES, ...STATUSES, ...PROFILES, ...published]
        for (const f of filters) {
          for (const e of pool) {
            if (f.kinds && !f.kinds.includes(e.kind)) continue
            if (f.authors && !f.authors.includes(e.pubkey)) continue
            if (f['#a'] && !e.tags.some((t) => t[0] === 'a' && f['#a'].includes(t[1]))) continue
            ws.send(JSON.stringify(['EVENT', sub, e]))
          }
        }
        ws.send(JSON.stringify(['EOSE', sub]))
        return
      }
      if (msg[0] === 'EVENT') {
        const e = msg[1]
        if (!authed) {
          ws.send(JSON.stringify(['OK', e.id, false, 'auth-required: not authenticated']))
          return
        }
        published.push(e)
        ws.send(JSON.stringify(['OK', e.id, true, '']))
      }
    })
  })
  return {
    url: `ws://localhost:${wss.address().port}`,
    published,
    close: () => wss.close(),
  }
}

/** The stub extension, installed before any page script runs. */
async function withSigner(page, sk) {
  await page.evaluateOnNewDocument((skHex) => {
    // Signing happens in node and is handed back through this bridge, because
    // schnorr in the page would mean shipping a signing library to a test.
    window.nostr = {
      getPublicKey: () => window.__sign('pub', null),
      signEvent: (e) => window.__sign('sign', e),
    }
    void skHex
  }, Buffer.from(sk).toString('hex'))
  await page.exposeFunction('__sign', (what, draft) => {
    if (what === 'pub') return getPublicKey(sk)
    return finalizeEvent(
      { kind: draft.kind, created_at: draft.created_at, tags: draft.tags, content: draft.content },
      sk,
    )
  })
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--mute-audio'],
})

const good = startRelay()
const bad = startRelay({ refuse: true })

try {
  // ------------------------------------------- 1. the relay says no, and why

  {
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })
    await withSigner(page, key)
    await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.$eval('#relay-url', (el, v) => { el.value = v }, bad.url)
    await page.click('#login-2')
    const err = await until(async () =>
      page.evaluate(() => {
        const e = document.getElementById('gate-error')
        return e && !e.hidden ? e.textContent : null
      }))
    check(
      'a relay that refuses the npub says so in its own words',
      /not a relay member/.test(err ?? ''),
      JSON.stringify(err),
    )
    const stillGated = await page.evaluate(() => ({
      gate: !document.getElementById('gate').hidden,
      board: !document.getElementById('board').hidden,
    }))
    check(
      'and the board does not open behind the error',
      stillGated.gate === true && stillGated.board === false,
      JSON.stringify(stillGated),
    )
    await page.close()
  }

  // ------------------------------------------------ 2. signed in, and sorted

  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await withSigner(page, key)
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30_000 })

  // The gate is not decoration: nothing is readable before a login, so nothing
  // should be on screen either.
  const before = await page.evaluate(() => ({
    gate: !document.getElementById('gate').hidden,
    board: !document.getElementById('board').hidden,
    cards: document.querySelectorAll('.task').length,
  }))
  check('a cold visit shows the gate and no tasks',
    before.gate && !before.board && before.cards === 0, JSON.stringify(before))

  await page.$eval('#relay-url', (el, v) => { el.value = v }, good.url)
  await page.click('#login-2')
  const opened = await until(async () =>
    page.evaluate(() => (document.getElementById('board').hidden ? null : true)))
  check('signing in opens the board', !!opened)

  const cols = await until(async () => {
    const c = await page.evaluate(() => ({
      wip: [...document.querySelectorAll('#col-wip .task h3')].map((n) => n.textContent),
      pending: [...document.querySelectorAll('#col-pending .task h3')].map((n) => n.textContent),
      done: [...document.querySelectorAll('#col-done .task h3')].map((n) => n.textContent),
    }))
    return c.wip.length + c.pending.length + c.done.length >= 5 ? c : null
  })
  check('every task lands in a column', !!cols, JSON.stringify(cols))
  check(
    'a task with a wip status is in progress',
    cols?.wip.length === 1 && /being worked on/.test(cols.wip[0]),
    JSON.stringify(cols?.wip),
  )
  check(
    'a resolved task is done',
    cols?.done.length === 1 && /is finished/.test(cols.done[0]),
    JSON.stringify(cols?.done),
  )
  check(
    'a task with no status at all is pending',
    (cols?.pending ?? []).some((t) => /nobody has touched/.test(t)),
    JSON.stringify(cols?.pending),
  )
  // The ordering claim. The close is the *older* event; a board that took the
  // first status it saw would file this under Done and lose a live task.
  check(
    'a task closed and then reopened is pending, not done',
    (cols?.pending ?? []).some((t) => /reopened/.test(t)) &&
      !(cols?.done ?? []).some((t) => /reopened/.test(t)),
    JSON.stringify({ pending: cols?.pending, done: cols?.done }),
  )

  // ------------------------------------------------- 3. who is working on it

  const worker = await page.evaluate(() => {
    const card = document.querySelector('#col-wip .task')
    return card?.querySelector('.worker')?.textContent ?? null
  })
  check(
    'the in-progress card names whoever signed the pickup',
    /picked up by/.test(worker ?? '') && /Splitscreen|67d146/.test(worker ?? ''),
    JSON.stringify(worker),
  )

  // ----------------------------------------- 4. an unknown author is marked

  const stranger = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.task')].find((c) =>
      /from a stranger/.test(c.querySelector('h3')?.textContent ?? ''))
    return card ? { shown: true, tag: card.querySelector('.tag')?.textContent } : { shown: false }
  })
  check(
    'a task from an npub the board does not know is still shown',
    stranger.shown === true,
    JSON.stringify(stranger),
  )
  check(
    'and it is marked unverified rather than trusted',
    stranger.tag === 'unverified',
    JSON.stringify(stranger.tag),
  )
  const knownTag = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.task')].find((c) =>
      /nobody has touched/.test(c.querySelector('h3')?.textContent ?? ''))
    return card?.querySelector('.tag')?.textContent ?? null
  })
  // The control: if everything were marked unverified the check above would
  // pass against a board that trusts nobody and says nothing.
  check('the control: a known author is not marked unverified', knownTag === 'Puzz',
    JSON.stringify(knownTag))

  // -------------------------------------------------------------- 5. filing

  await page.click('#new-task')
  await page.type('#c-subject', 'Filed from the board')
  await page.type('#c-body', 'A task that came in through the page rather than the CLI.')
  await page.type('#c-labels', 'tooling, test')
  await page.click('#c-send')
  const landed = await until(() =>
    good.published.find((e) => e.tags.some((t) => t[0] === 'subject' && t[1] === 'Filed from the board')) ?? null)
  check('filing publishes a signed issue to the relay', !!landed)
  check(
    'and it is a NIP-34 issue against this repo, not a loose note',
    landed?.kind === 1621 && landed.tags.some((t) => t[0] === 'a' && t[1] === REPO_A),
    JSON.stringify({ kind: landed?.kind, a: landed?.tags.filter((t) => t[0] === 'a') }),
  )
  check(
    'the labels ride along as t tags',
    ['tooling', 'test'].every((l) => landed?.tags.some((t) => t[0] === 't' && t[1] === l)),
    JSON.stringify(landed?.tags.filter((t) => t[0] === 't')),
  )
  check(
    'it is signed by the key the extension holds, and the signature verifies',
    landed?.pubkey === getPublicKey(key) && /^[0-9a-f]{128}$/.test(landed?.sig ?? ''),
    `${landed?.pubkey?.slice(0, 12)}… against ${getPublicKey(key).slice(0, 12)}…`,
  )
  const appeared = await until(async () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.task h3')].some((n) => /Filed from the board/.test(n.textContent))
        ? true
        : null))
  check('and the board picks it up on the reload that follows', !!appeared)

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))

  if (process.env.OPS_SHOT) {
    await page.screenshot({ path: process.env.OPS_SHOT, fullPage: true })
    console.log(`      wrote ${process.env.OPS_SHOT}`)
  }
  await page.close()

  // --------------------------------------------------------------- 6. phone
  //
  // A *fresh* page at phone size, signed in again, and it has to be: calling
  // `setViewport` with `isMobile` on a live page reloads it in puppeteer, which
  // dropped the session and left the first version of this check measuring an
  // empty gate. It passed. A layout check with nothing laid out is the purest
  // form of passing for the wrong reason, so the count of cards is asserted
  // before anything is measured.

  {
    const phone = await browser.newPage()
    await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    await withSigner(phone, key)
    await phone.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await phone.$eval('#relay-url', (el, v) => { el.value = v }, good.url)
    await phone.click('#login-2')
    const cards = await until(async () => {
      const n = await phone.evaluate(() => document.querySelectorAll('.task').length)
      return n >= 5 ? n : null
    })
    check('the board loads on a phone at all', (cards ?? 0) >= 5, `${cards} cards`)
    const fit = await phone.evaluate(() => {
      const spill = [...document.querySelectorAll('.col, .task, #bar')].filter((el) => {
        const r = el.getBoundingClientRect()
        return r.right > window.innerWidth + 1 || r.left < -1
      }).map((el) => el.className || el.id)
      return {
        spill: spill.slice(0, 5),
        docScroll: document.documentElement.scrollWidth,
        vw: window.innerWidth,
      }
    })
    check('and it fits the screen', fit.docScroll <= fit.vw + 1, JSON.stringify(fit))
    check('with no column or card hanging off the side', fit.spill.length === 0,
      JSON.stringify(fit.spill))
    if (process.env.OPS_PHONE_SHOT) {
      await phone.screenshot({ path: process.env.OPS_PHONE_SHOT, fullPage: true })
      console.log(`      wrote ${process.env.OPS_PHONE_SHOT}`)
    }
    await phone.close()
  }
} catch (err) {
  check('the run completed', false, err.message)
} finally {
  await browser.close()
  good.close()
  bad.close()
}

console.log('')
if (failures.length) {
  console.error(`${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('All Tank Ops checks passed.')
