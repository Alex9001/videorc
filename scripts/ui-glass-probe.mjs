// probe:ui-glass: real composited glass checks for every Videorc window.
//
// Launches the dev app with isolated user data, puts a stand-in wallpaper
// behind each window (the smoke backdrop; the user's real desktop is never
// captured), REGION-captures the window (`screencapture -R`, the only capture
// that shows macOS vibrancy) and measures a text-free sample rect:
//
//   transmission  colour distance between the red- and blue-backdrop shots:
//                 real glass lets the desktop colour through
//   sharpness     Laplacian variance over the dense-text backdrop: blurred
//                 glass is smooth; a translucent coat over sharp text is not
//                 (the July text leak, as a number)
//   contrast      text tokens against the coat measured over white and black
//   pinned        the dark-always Preview stays dark while main is in light theme
//   followsTheme  Stream Manager, Captions and Notes pages carry the app theme
//   native        the window's NSVisualEffectViews read back as `active`
//                 (window-glass-state), so the glass never follows focus
//
// The run never activates the app: the backdrop and the window under test sit
// on floating levels and are shown inactive, so the user's focus (and their
// keystrokes: a stray D flips the app theme) stays where it is. Every window
// is therefore measured unfocused, the state Chat and Captions live in during
// a stream; the material is `visualEffectState: 'active'` either way.
//
// --surfaces adds the floating glass (plan 072) on main and chat: the real
// `glass-float` utility painted over a text-free patch of the window and over
// app text (sidebar rows, Stream Manager filters), scored by
// scripts/lib/float-glass-checks.mjs (lift over the window glass, text
// contrast, no bleed of the text underneath). The old near-opaque popover
// coat is measured beside it as an ungated control, so the report shows the slab the
// gate exists to catch. The primitives' use of the utility is pinned by the
// renderer guard tests.
//
// Report mode prints every metric; --gate fails the run on any check.
//
//   node scripts/ui-glass-probe.mjs [--gate] [--surfaces] [--themes=dark,light]
//     [--roles=main,chat,captions,notes,preview]
//
// Extra app env rides in VIDEORC_UI_GLASS_APP_ENV (JSON), e.g.
// '{"VIDEORC_GLASS":"0"}' to measure the solid palette.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import {
  belowSheen,
  centredRect,
  evaluateFloatBleed,
  evaluateFloatPatch,
  FLOAT_GLASS_THRESHOLDS,
  growRect
} from './lib/float-glass-checks.mjs'
import {
  colorDistance,
  contrastRatio,
  decodePng,
  laplacianVariance,
  parseHexColor,
  regionMean,
  relativeLuminance
} from './lib/image-stats.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'

// Calibrated on macOS 26.5.1 / Electron 39.8.10; the raw populations live in
// docs/acceptance/2026-09-23-real-glass-calibration.md. Transmission: the fake
// frost measured <= 3.9, real glass >= 9.8. Sharpness: real glass <= 0.3 away
// from edges and <= 4.2 within the blur reach of a window edge (the 28pt
// Preview strip), a transparent window without the material (text readable
// behind) >= 11.8.
export const GLASS_THRESHOLDS = Object.freeze({
  minTransmission: 8,
  maxSharpness: 6,
  minPrimaryContrast: 7,
  minSecondaryContrast: 4.5,
  maxPinnedLuminance: 0.12
})

// sRGB of the text tokens in styles.css: --foreground / --muted-foreground
// (dark oklch 0.97 / 0.71, light oklch 0.17 / 0.47).
const TEXT = {
  dark: { primary: parseHexColor('#F5F5F6'), secondary: parseHexColor('#A1A1A6') },
  light: { primary: parseHexColor('#101012'), secondary: parseHexColor('#5B5B5E') }
}

// Sample rects in window points, chosen text-free in every layout the plan
// ships: the middle of a toolbar row, the empty foot of the sidebar, the empty
// top of a list or textarea. Functions of the window size.
const SAMPLES = {
  main: [
    {
      name: 'content-toolbar',
      rect: (w) => ({ x: w.width * 0.45, y: 8, width: w.width * 0.15, height: 18 })
    },
    { name: 'sidebar-foot', rect: (w) => ({ x: 20, y: w.height - 108, width: 150, height: 40 }) }
  ],
  chat: [
    {
      name: 'list-foot',
      rect: (w) => ({ x: 24, y: w.height - 260, width: w.width - 48, height: 120 })
    }
  ],
  captions: [{ name: 'body', rect: (w) => ({ x: 40, y: 52, width: w.width - 80, height: 40 }) }],
  notes: [
    {
      name: 'textarea',
      rect: (w) => ({ x: w.width * 0.4, y: 150, width: w.width * 0.5, height: 120 })
    }
  ],
  preview: [
    { name: 'strip', rect: (w) => ({ x: w.width * 0.55, y: 6, width: w.width * 0.4, height: 14 }) }
  ]
}

const OPEN_COMMAND = {
  chat: 'comments-window-open',
  captions: 'captions-window-open',
  notes: 'notes-window-open',
  preview: 'preview-window-open'
}
const SET_BOUNDS_COMMAND = {
  main: 'main-window-set-bounds',
  chat: 'comments-window-set-bounds',
  captions: 'captions-window-set-bounds',
  notes: 'notes-window-set-bounds',
  preview: 'preview-window-set-bounds'
}
const PINNED_DARK_ROLES = new Set(['preview'])

// Floating glass (--surfaces): the roles with a renderer page to paint on, the
// backdrops each patch is shot over, and the pre-072 popover coat (the
// control). A patch is a hover-card-sized sample inside the role's first
// text-free window sample; the surface overhangs it by the blur reach.
const SURFACE_ROLES = new Set(['main', 'chat'])
const BACKDROPS = ['red', 'blue', 'white', 'black', 'text']
const SURFACE_OVERHANG = 30
// App text each role's bleed check hides: the sidebar rows (the selected
// row's primary text among them) and the Stream Manager filter labels, the
// white text a 97% coat still leaked on the owner's hover card.
const TEXT_ROWS = {
  main: 'aside a, aside button',
  chat: '[data-slot="chat-filters"] button'
}
const OLD_POPOVER_COAT = {
  dark: 'oklch(0.16 0.004 286 / 92%)',
  light: 'oklch(0.99 0 0 / 92%)'
}

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const option = (name, fallback) =>
  argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const gate = flag('gate')
const surfaces = flag('surfaces')
const themes = option('themes', 'dark,light').split(',')
const roles = option('roles', 'main,chat,captions,notes,preview').split(',')
const extraAppEnv = process.env.VIDEORC_UI_GLASS_APP_ENV
  ? JSON.parse(process.env.VIDEORC_UI_GLASS_APP_ENV)
  : {}
const outputDir =
  process.env.VIDEORC_UI_GLASS_OUTPUT_DIR ?? mkdtempSync(join(tmpdir(), 'videorc-ui-glass-'))
mkdirSync(outputDir, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET' }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (text += chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(text))
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function cdpEvaluate(webSocketUrl, expression) {
  const socket = new WebSocket(webSocketUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve)
    socket.addEventListener('error', () => reject(new Error('CDP connect failed')))
  })
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP evaluate timed out')), 10_000)
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data)
        if (message.id !== 1) return
        clearTimeout(timer)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result?.result?.value)
      })
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true }
        })
      )
    })
  } finally {
    socket.close()
  }
}

function targetMatcher(role) {
  if (role === 'main') return (url) => /^https?:\/\/localhost:\d+\/(index\.html)?(\?.*)?$/.test(url)
  if (role === 'chat') return (url) => /\/comments\.html/.test(url)
  if (role === 'captions') return (url) => /\/captions\.html/.test(url)
  if (role === 'notes')
    return (url) => /\/notes\.html/.test(url) || /Videorc%20Notes|Notes%20for%20this/.test(url)
  return () => false
}

async function pageTarget(devtoolsHost, role) {
  const targets = await fetchJson(`http://${devtoolsHost}/json/list`)
  const matches = targetMatcher(role)
  return targets.find((target) => target.type === 'page' && matches(target.url ?? '')) ?? null
}

// The page's theme class, or null for a window without a renderer page (Preview).
async function pageDarkClass(devtoolsHost, role) {
  const target = await pageTarget(devtoolsHost, role)
  return target
    ? await cdpEvaluate(
        target.webSocketDebuggerUrl,
        `document.documentElement.classList.contains('dark')`
      )
    : null
}

async function applyTheme(devtoolsHost, theme) {
  const main = await pageTarget(devtoolsHost, 'main')
  if (!main) throw new Error('Main window CDP target not found.')
  await cdpEvaluate(
    main.webSocketDebuggerUrl,
    `localStorage.setItem('videorc.onboardingComplete', 'creator-ux-v1'); localStorage.setItem('videorc.theme', ${JSON.stringify(theme)}); location.reload(); true`
  )
  await sleep(7000)
}

// A shot taken after the theme changed under the run would be scored against
// the wrong text tokens; fail loudly instead.
async function assertTheme(devtoolsHost, theme) {
  const main = await pageTarget(devtoolsHost, 'main')
  const dark = main
    ? await cdpEvaluate(
        main.webSocketDebuggerUrl,
        `document.documentElement.classList.contains('dark')`
      )
    : null
  if (dark !== (theme === 'dark')) {
    throw new Error(
      `Main window theme is not ${theme} (dark class: ${dark}); was the D key pressed in the app?`
    )
  }
}

function capture(bounds, name) {
  const file = join(outputDir, `${name}.png`)
  execFileSync('screencapture', [
    '-x',
    `-R${bounds.x},${bounds.y},${bounds.width},${bounds.height}`,
    file
  ])
  return file
}

function measure(file, bounds, role) {
  const image = decodePng(readFileSync(file))
  const scale = image.width / bounds.width
  return SAMPLES[role].map((sample) => {
    const points = sample.rect(bounds)
    const rect = {
      x: points.x * scale,
      y: points.y * scale,
      width: points.width * scale,
      height: points.height * scale
    }
    return {
      name: sample.name,
      mean: regionMean(image, rect),
      sharpness: laplacianVariance(image, rect)
    }
  })
}

async function shoot(smoke, theme, role, variant, prefix = '') {
  await requestSmokeCommand(
    smoke,
    'open-backdrop-window',
    { variant, raise: false },
    { timeoutMs: 20_000 }
  )
  const raised = await requestSmokeCommand(smoke, 'raise-window', { role, focus: false })
  await sleep(700)
  return { raised, file: capture(raised.bounds, `${prefix}${theme}-${role}-${variant}`) }
}

// Windows open asynchronously (the preview through its supervisor): wait for
// each role instead of failing on the first raise, asking once more midway.
async function waitForWindow(smoke, role) {
  const deadline = Date.now() + 20_000
  let reopened = false
  for (;;) {
    try {
      return await requestSmokeCommand(smoke, 'raise-window', { role, focus: false })
    } catch (error) {
      if (!/No open window/.test(String(error?.message)) || Date.now() > deadline) throw error
      if (!reopened && OPEN_COMMAND[role] && Date.now() > deadline - 12_000) {
        reopened = true
        await requestSmokeCommand(smoke, OPEN_COMMAND[role], {}, { timeoutMs: 20_000 })
      }
      await sleep(500)
    }
  }
}

async function placeOnPrimaryDisplay(smoke, role, index) {
  const { bounds, primaryWorkArea } = await waitForWindow(smoke, role)
  const width = Math.min(bounds.width, primaryWorkArea.width - 80)
  const height = Math.min(bounds.height, primaryWorkArea.height - 80)
  await requestSmokeCommand(smoke, SET_BOUNDS_COMMAND[role], {
    x: primaryWorkArea.x + 40 + index * 12,
    y: primaryWorkArea.y + 30 + index * 12,
    width,
    height
  })
}

// Paints a probe surface over `rect` (window points) in the role's page:
// `float` is the real glass-float utility, `control` the old popover coat,
// `leak` the utility at a 97% coat (the translucency that let white tab
// labels read through the hover card before the coat went opaque).
async function showSurface(devtoolsHost, role, bounds, rect, kind, theme) {
  const target = await pageTarget(devtoolsHost, role)
  if (!target) throw new Error(`No CDP target for ${role}; cannot paint a floating surface.`)
  const spec = JSON.stringify({
    rect,
    boundsWidth: bounds.width,
    kind,
    coat: OLD_POPOVER_COAT[theme]
  })
  await cdpEvaluate(
    target.webSocketDebuggerUrl,
    `(() => {
      const spec = ${spec};
      document.getElementById('ui-glass-probe-surface')?.remove();
      const scale = innerWidth / spec.boundsWidth;
      const el = document.createElement('div');
      el.id = 'ui-glass-probe-surface';
      el.className = spec.kind === 'control' ? 'rounded-lg border' : 'rounded-lg border glass-float';
      Object.assign(el.style, {
        position: 'fixed', zIndex: '2147483647', pointerEvents: 'none',
        left: spec.rect.x * scale + 'px', top: spec.rect.y * scale + 'px',
        width: spec.rect.width * scale + 'px', height: spec.rect.height * scale + 'px'
      });
      if (spec.kind === 'control') el.style.backgroundColor = spec.coat;
      if (spec.kind === 'leak') {
        el.style.backgroundColor = 'color-mix(in oklch, var(--glass-float) 97%, transparent)';
      }
      document.body.appendChild(el);
      return true;
    })()`
  )
}

async function hideSurface(devtoolsHost, role) {
  const target = await pageTarget(devtoolsHost, role)
  if (!target) return
  await cdpEvaluate(
    target.webSocketDebuggerUrl,
    `(() => { document.getElementById('ui-glass-probe-surface')?.remove(); return true })()`
  )
}

// The union of the role's first rows with text (TEXT_ROWS), in window points:
// the app text a floating surface must hide. Null when the page has none.
async function appTextRect(devtoolsHost, role, bounds) {
  const target = await pageTarget(devtoolsHost, role)
  const found = await cdpEvaluate(
    target.webSocketDebuggerUrl,
    `(() => {
      const rows = Array.from(document.querySelectorAll(${JSON.stringify(TEXT_ROWS[role])}))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 30 && r.height > 12 && r.top > 30 && (el.textContent || '').trim().length > 2;
        })
        .slice(0, 3)
        .map((el) => el.getBoundingClientRect());
      if (!rows.length) return null;
      const x = Math.min(...rows.map((r) => r.left));
      const y = Math.min(...rows.map((r) => r.top));
      return {
        x, y,
        width: Math.max(...rows.map((r) => r.right)) - x,
        height: Math.max(...rows.map((r) => r.bottom)) - y,
        innerWidth
      };
    })()`
  )
  if (!found) return null
  const scale = bounds.width / found.innerWidth
  return {
    x: found.x * scale,
    y: found.y * scale,
    width: found.width * scale,
    height: found.height * scale
  }
}

function regionAt(file, bounds, rect) {
  const image = decodePng(readFileSync(file))
  const scale = image.width / bounds.width
  const pixels = {
    x: rect.x * scale,
    y: rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale
  }
  return { mean: regionMean(image, pixels), sharpness: laplacianVariance(image, pixels) }
}

// Floating glass on one role: the patch over every backdrop without the
// surface (the window shots already taken), with glass-float, and with the
// old coat; then the bleed of the role's app text through it.
async function measureSurfaces(smoke, devtoolsHost, theme, role, windowFiles, bounds) {
  const results = []
  const patch = centredRect(SAMPLES[role][0].rect(bounds), 160, 18)
  const surfaceRect = growRect(patch, SURFACE_OVERHANG, bounds)
  const windowMeans = Object.fromEntries(
    BACKDROPS.map((variant) => [variant, regionAt(windowFiles[variant], bounds, patch).mean])
  )
  const means = {}
  for (const kind of ['float', 'control']) {
    await showSurface(devtoolsHost, role, bounds, surfaceRect, kind, theme)
    means[kind] = {}
    for (const variant of BACKDROPS) {
      const { raised, file } = await shoot(smoke, theme, role, variant, `${kind}-`)
      means[kind][variant] = regionAt(file, raised.bounds, patch).mean
    }
  }
  const text = TEXT[theme]
  const float = evaluateFloatPatch({ theme, windowMeans, surfaceMeans: means.float, text })
  const control = evaluateFloatPatch({ theme, windowMeans, surfaceMeans: means.control, text })
  results.push({
    theme,
    role,
    sample: 'float-patch',
    metrics: { ...float.metrics, controlLiftMin: control.metrics.liftMin },
    checks: float.checks,
    pass: float.pass
  })

  const textRect = await appTextRect(devtoolsHost, role, bounds)
  if (textRect) {
    await hideSurface(devtoolsHost, role)
    const under = await shoot(smoke, theme, role, 'photo', 'bleed-under-')
    const surfaceRect = growRect(textRect, SURFACE_OVERHANG, bounds)
    const sample = belowSheen(textRect, surfaceRect)
    await showSurface(devtoolsHost, role, bounds, surfaceRect, 'float', theme)
    const through = await shoot(smoke, theme, role, 'photo', 'bleed-through-')
    await showSurface(devtoolsHost, role, bounds, surfaceRect, 'leak', theme)
    const leak = await shoot(smoke, theme, role, 'photo', 'bleed-leak-')
    const bleed = evaluateFloatBleed({
      sharpnessUnder: regionAt(under.file, under.raised.bounds, sample).sharpness,
      sharpnessThrough: regionAt(through.file, through.raised.bounds, sample).sharpness
    })
    const leakSharpness = regionAt(leak.file, leak.raised.bounds, sample).sharpness
    results.push({
      theme,
      role,
      sample: 'float-bleed',
      ...bleed,
      metrics: { ...bleed.metrics, leakSharpnessThrough: round(leakSharpness) }
    })
  } else {
    results.push({
      theme,
      role,
      sample: 'float-bleed',
      metrics: {},
      checks: { textPresent: false },
      pass: false
    })
  }
  await hideSurface(devtoolsHost, role)
  return results
}

function round(value, digits = 2) {
  return Number(value.toFixed(digits))
}

function evaluate(theme, role, shots, glassState, pageDark) {
  const results = []
  const byName = (variant) => shots[variant]
  for (const [index, sample] of SAMPLES[role].entries()) {
    const at = (variant) => byName(variant)[index]
    const transmission = colorDistance(at('red').mean, at('blue').mean)
    const sharpness = at('text').sharpness
    const text = TEXT[PINNED_DARK_ROLES.has(role) ? 'dark' : theme]
    const backgrounds = [at('white').mean, at('black').mean]
    const primaryContrast = Math.min(...backgrounds.map((bg) => contrastRatio(text.primary, bg)))
    const secondaryContrast = Math.min(
      ...backgrounds.map((bg) => contrastRatio(text.secondary, bg))
    )
    const whiteLuminance = relativeLuminance(at('white').mean)
    const checks = {
      transmission: transmission >= GLASS_THRESHOLDS.minTransmission,
      sharpness: sharpness <= GLASS_THRESHOLDS.maxSharpness,
      primaryContrast: primaryContrast >= GLASS_THRESHOLDS.minPrimaryContrast,
      secondaryContrast: secondaryContrast >= GLASS_THRESHOLDS.minSecondaryContrast
    }
    if (theme === 'light' && PINNED_DARK_ROLES.has(role)) {
      checks.pinnedDark = whiteLuminance <= GLASS_THRESHOLDS.maxPinnedLuminance
    }
    if (role !== 'main' && !PINNED_DARK_ROLES.has(role)) {
      checks.followsTheme = pageDark === (theme === 'dark')
    }
    const effectViews = glassState?.effectViews ?? []
    checks.native = effectViews.length > 0 && effectViews.every((view) => view.state === 'active')
    results.push({
      theme,
      role,
      sample: sample.name,
      metrics: {
        glass: glassState?.applied?.mode?.kind ?? 'unknown',
        transmission: round(transmission),
        sharpness: round(sharpness),
        primaryContrast: round(primaryContrast),
        secondaryContrast: round(secondaryContrast),
        whiteLuminance: round(whiteLuminance, 4)
      },
      checks,
      pass: Object.values(checks).every(Boolean)
    })
  }
  return results
}

// Instantaneous WindowServer CPU (top samples; ps reports a decaying average
// that would still carry the capture burst). Read-only: never signalled.
function sampleWindowServerCpu(samples = 12) {
  const rows = execFileSync('ps', ['-Ao', 'pid=,comm='], { encoding: 'utf8' }).split('\n')
  const pid = rows
    .map((line) => line.trim().split(/\s+/))
    .find(([, command]) => /(^|\/)WindowServer$/.test(command ?? ''))?.[0]
  if (!pid) return null
  const output = execFileSync(
    'top',
    ['-l', String(samples + 1), '-s', '1', '-pid', pid, '-stats', 'pid,cpu'],
    { encoding: 'utf8' }
  )
  const readings = output
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([rowPid]) => rowPid === pid)
    .map(([, cpu]) => Number(cpu))
    .slice(1)
  if (!readings.length) return null
  return round(readings.reduce((sum, value) => sum + value, 0) / readings.length, 1)
}

function writeContactSheet(files) {
  try {
    const sheet = join(outputDir, 'contact-sheet.png')
    const argsList = ['montage', ...files.flatMap(({ file, label }) => ['-label', label, file])]
    argsList.push('-tile', '3x', '-geometry', '640x420+10+10', '-background', '#e9e9ec', sheet)
    execFileSync('magick', argsList, { stdio: 'ignore' })
    return sheet
  } catch {
    return null
  }
}

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-ui-glass-profile-'))
  let devtoolsUrl = null
  const launched = await launchDevApp({
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    timeoutMs: Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 540_000),
    env: {
      VIDEORC_SMOKE_PREVIEW_MOTION: '1',
      VIDEORC_SMOKE_GLASS_PROBE_NOTES_VISIBLE: '1',
      VIDEORC_USER_DATA_DIR: userDataDir,
      VIDEORC_DATABASE_PATH: join(userDataDir, 'videorc.sqlite3'),
      VIDEORC_REMOTE_DEBUG_PORT: '0',
      ...extraAppEnv
    },
    onLine: (line) => {
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(line)
      if (match) devtoolsUrl = match[1]
    }
  })
  const smoke = launched.connections['preview-motion-ready']
  const report = {
    thresholds: GLASS_THRESHOLDS,
    floatThresholds: surfaces ? FLOAT_GLASS_THRESHOLDS : undefined,
    extraAppEnv,
    results: [],
    windowServerCpu: null
  }
  const looks = []
  try {
    if (!devtoolsUrl) throw new Error('No DevTools endpoint observed (VIDEORC_REMOTE_DEBUG_PORT).')
    const devtoolsHost = new URL(devtoolsUrl.replace('ws://', 'http://')).host
    await sleep(6000)
    for (const role of roles) {
      if (OPEN_COMMAND[role]) {
        await requestSmokeCommand(smoke, OPEN_COMMAND[role], {}, { timeoutMs: 20_000 })
      }
    }
    await sleep(2500)
    for (const [index, role] of roles.entries()) {
      await placeOnPrimaryDisplay(smoke, role, index)
    }

    for (const theme of themes) {
      await applyTheme(devtoolsHost, theme)
      for (const role of roles) {
        await assertTheme(devtoolsHost, theme)
        const shots = {}
        const files = {}
        let bounds = null
        for (const variant of BACKDROPS) {
          const { raised, file } = await shoot(smoke, theme, role, variant)
          shots[variant] = measure(file, raised.bounds, role)
          files[variant] = file
          bounds = raised.bounds
        }
        await assertTheme(devtoolsHost, theme)
        const look = await shoot(smoke, theme, role, 'photo')
        looks.push({ file: look.file, label: `${theme} · ${role}` })
        const glassState = await requestSmokeCommand(smoke, 'window-glass-state', { role })
        const pageDark = await pageDarkClass(devtoolsHost, role)
        report.results.push(...evaluate(theme, role, shots, glassState, pageDark))
        if (surfaces && SURFACE_ROLES.has(role)) {
          report.results.push(
            ...(await measureSurfaces(smoke, devtoolsHost, theme, role, files, bounds))
          )
          await showSurface(
            devtoolsHost,
            role,
            bounds,
            growRect(centredRect(SAMPLES[role][0].rect(bounds), 160, 18), 60, bounds),
            'float',
            theme
          )
          const surfaceLook = await shoot(smoke, theme, role, 'photo', 'float-look-')
          looks.push({ file: surfaceLook.file, label: `${theme} · ${role} · glass-float` })
          await hideSurface(devtoolsHost, role)
        }
      }
    }
    await requestSmokeCommand(smoke, 'close-backdrop-window')
    // Let the capture burst settle before measuring the steady state.
    await sleep(20_000)
    report.windowServerCpu = sampleWindowServerCpu()
  } finally {
    await launched.stop()
  }

  report.contactSheet = writeContactSheet(looks)
  report.outputDir = outputDir
  writeFileSync(join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

  for (const result of report.results) {
    const failed = Object.entries(result.checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name)
    console.log(
      `${result.pass ? 'PASS' : 'FAIL'} ${result.theme.padEnd(5)} ${result.role.padEnd(8)} ${result.sample.padEnd(15)} ${JSON.stringify(result.metrics)}${failed.length ? ` failed=${failed.join(',')}` : ''}`
    )
  }
  console.log(`WindowServer CPU (idle, preview presenting): ${report.windowServerCpu ?? 'n/a'}%`)
  console.log(`report: ${join(outputDir, 'report.json')}`)
  if (report.contactSheet) console.log(`contact sheet: ${report.contactSheet}`)
  const failures = report.results.filter((result) => !result.pass)
  if (gate && failures.length) {
    console.error(
      `probe:ui-glass FAILED: ${failures.length} sample(s) outside the glass thresholds.`
    )
    process.exit(1)
  }
  console.log(gate ? 'probe:ui-glass PASSED' : 'probe:ui-glass report complete (report mode).')
}

main().catch((error) => {
  console.error(`probe:ui-glass error: ${error?.stack ?? error}`)
  process.exit(1)
})
