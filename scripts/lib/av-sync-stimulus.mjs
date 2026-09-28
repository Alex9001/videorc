import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  resolveScreenMotionStimulusBrowser,
  resolveWindowsStimulusBrowser,
  stopStimulusBrowserTree,
  stimulusWindowOptionsForSource
} from './screen-motion-stimulus.mjs'

const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export function resolveAvSyncStimulusBrowser({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  requestedPath
} = {}) {
  if (platform === 'win32') {
    return resolveWindowsStimulusBrowser({
      env,
      exists,
      requestedPath,
      legacyEnvironmentVariable: 'VIDEORC_AV_SYNC_BROWSER_PATH'
    })
  }
  return resolveScreenMotionStimulusBrowser({
    platform,
    env: {
      ...env,
      VIDEORC_SCREEN_MOTION_BROWSER_PATH: env.VIDEORC_AV_SYNC_BROWSER_PATH ?? DEFAULT_CHROME_PATH
    },
    exists,
    requestedPath
  })
}

export async function launchAvSyncStimulus(options = {}) {
  const displayOptions = stimulusWindowOptionsForSource(options.screenSource) ?? {}
  const browserResolution = resolveAvSyncStimulusBrowser({
    requestedPath: options.browserPath
  })
  const browserPath = browserResolution.executablePath
  const x = Number(options.x ?? process.env.VIDEORC_AV_SYNC_X ?? displayOptions.x ?? 16)
  const y = Number(options.y ?? process.env.VIDEORC_AV_SYNC_Y ?? displayOptions.y ?? 16)
  const width = Number(
    options.width ?? process.env.VIDEORC_AV_SYNC_WIDTH ?? displayOptions.width ?? 1800
  )
  const height = Number(
    options.height ?? process.env.VIDEORC_AV_SYNC_HEIGHT ?? displayOptions.height ?? 980
  )
  const settleMs = Number(options.settleMs ?? process.env.VIDEORC_AV_SYNC_SETTLE_MS ?? 1800)

  if (!browserPath) {
    throw new Error(
      `A/V sync stimulus requires a Chromium-compatible browser. ` +
        `Set VIDEORC_STIMULUS_BROWSER, or install Edge/Chrome. ` +
        `Checked: ${browserResolution.searchedPaths.join(', ') || 'no Windows browser roots were available'}.`
    )
  }

  const dir = mkdtempSync(join(tmpdir(), 'videorc-av-sync-'))
  const htmlPath = join(dir, 'stimulus.html')
  const profileDir = join(dir, 'profile')
  writeFileSync(htmlPath, stimulusHtml(), 'utf8')
  // Opt-in readiness channel: the page reports every pulse (audio state,
  // focus, visibility) to a loopback beacon, and launch waits for a running,
  // focused, visible pulse instead of a fixed settle. A browser that starts
  // slowly, or opens behind other windows, records no flashes otherwise.
  const readiness = options.waitForReady ? await startReadinessBeacon() : null
  const pageUrl = new URL(pathToFileURL(htmlPath).href)
  if (readiness) pageUrl.searchParams.set('beacon', readiness.url)

  const child = spawn(
    browserPath,
    [
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-extensions',
      ...(readiness
        ? [
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding'
          ]
        : []),
      '--autoplay-policy=no-user-gesture-required',
      '--force-device-scale-factor=1',
      `--window-position=${x},${y}`,
      `--window-size=${width},${height}`,
      `--app=${pageUrl.href}`
    ],
    {
      detached: true,
      stdio: 'ignore'
    }
  )
  child.unref()
  const stimulus = {
    child,
    dir,
    htmlPath,
    browserPath,
    browserSource: browserResolution.source,
    x,
    y,
    width,
    height,
    readiness
  }
  try {
    if (readiness) {
      const timeoutMs = Number(
        options.readyTimeoutMs ?? process.env.VIDEORC_AV_SYNC_READY_TIMEOUT_MS ?? 30000
      )
      stimulus.ready = await readiness.waitFor(avSyncStimulusPulseReady, timeoutMs, () => {
        if (child.exitCode !== null) {
          throw new Error(`A/V sync stimulus browser exited early with code ${child.exitCode}.`)
        }
      })
    } else {
      await sleep(settleMs)
    }
    if (child.exitCode !== null) {
      throw new Error(`A/V sync stimulus browser exited early with code ${child.exitCode}.`)
    }
    return stimulus
  } catch (error) {
    await stopAvSyncStimulus(stimulus, options.teardownOptions)
    throw error
  }
}

export async function stopAvSyncStimulus(stimulus, options = {}) {
  stimulus?.readiness?.close()
  return await stopStimulusBrowserTree(stimulus, options)
}

/** A pulse proves the stimulus is live: audio running, window focused and visible. */
export function avSyncStimulusPulseReady(pulse) {
  return pulse?.state === 'running' && pulse?.focus === '1' && pulse?.visible === 'visible'
}

/** Parses one beacon request (`/pulse?n=..&state=..&focus=..&visible=..`). */
export function parseAvSyncStimulusPulse(requestUrl) {
  const url = new URL(requestUrl, 'http://127.0.0.1')
  if (url.pathname !== '/pulse') return null
  return {
    count: Number(url.searchParams.get('n') ?? 0),
    state: url.searchParams.get('state'),
    focus: url.searchParams.get('focus'),
    visible: url.searchParams.get('visible')
  }
}

function startReadinessBeacon() {
  return new Promise((resolveBeacon, rejectBeacon) => {
    const pulses = []
    const server = createServer((request, response) => {
      const pulse = parseAvSyncStimulusPulse(request.url ?? '/')
      if (pulse) pulses.push({ ...pulse, at: Date.now() })
      response.writeHead(204, { 'access-control-allow-origin': '*' })
      response.end()
    })
    server.on('error', rejectBeacon)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolveBeacon({
        url: `http://127.0.0.1:${port}/`,
        pulses,
        close: () => server.close(),
        async waitFor(predicate, timeoutMs, check) {
          const deadline = Date.now() + timeoutMs
          for (;;) {
            const pulse = pulses.find(predicate)
            if (pulse) return pulse
            check?.()
            if (Date.now() > deadline) {
              throw new Error(
                `A/V sync stimulus was not live, focused and visible within ${timeoutMs}ms (last pulse: ${JSON.stringify(pulses.at(-1) ?? null)}).`
              )
            }
            await sleep(100)
          }
        }
      })
    })
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stimulusHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Videorc A/V Sync Stimulus</title>
  <style>
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #000;
      color: #fff;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    #stage {
      position: fixed;
      inset: 0;
      background: #000;
    }
    #stage.flash {
      background: #fff;
    }
    #counter {
      position: fixed;
      left: 3vw;
      bottom: 3vh;
      padding: 0.2em 0.35em;
      background: rgba(0, 0, 0, 0.78);
      color: #fff;
      font-size: 6vh;
      font-weight: 800;
    }
    #sweep {
      position: fixed;
      top: 0;
      bottom: 0;
      width: 18vw;
      background: linear-gradient(90deg, transparent, #115566, #221144, transparent);
      opacity: 0.74;
      will-change: transform;
    }
    #ticker {
      position: fixed;
      left: 0;
      right: 0;
      top: 5vh;
      padding: 0.25em 0;
      background: #151515;
      color: #7de7ff;
      font-size: 4vh;
      white-space: nowrap;
      will-change: transform;
    }
    .dot {
      position: fixed;
      width: 7vh;
      height: 7vh;
      border: 1vh solid #6cff8d;
      border-radius: 999px;
      box-shadow: 0 0 0 0.6vh #111;
      will-change: transform;
    }
  </style>
</head>
<body>
  <div id="stage"></div>
  <div id="sweep"></div>
  <div id="ticker">VIDEORC A/V SYNC STIMULUS - continuous low-luma motion plus one full-frame flash/click each second - </div>
  <div id="dot" class="dot"></div>
  <div id="counter">sync 0000</div>
  <script>
    const stage = document.getElementById('stage');
    const sweep = document.getElementById('sweep');
    const ticker = document.getElementById('ticker');
    const dot = document.getElementById('dot');
    const counter = document.getElementById('counter');
    const audio = new AudioContext();
    let count = 0;
    let frame = 0;

    function click() {
      const now = audio.currentTime;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = 1000;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.8, now + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start(now);
      osc.stop(now + 0.07);
    }

    const beacon = new URLSearchParams(location.search).get('beacon');

    function report() {
      if (!beacon) return;
      const query = new URLSearchParams({
        n: String(count),
        state: audio.state,
        focus: document.hasFocus() ? '1' : '0',
        visible: document.visibilityState
      });
      new Image().src = beacon + 'pulse?' + query.toString();
    }

    function pulse() {
      audio.resume();
      count += 1;
      counter.textContent = 'sync ' + String(count).padStart(4, '0');
      stage.classList.add('flash');
      click();
      setTimeout(() => stage.classList.remove('flash'), 50);
      report();
    }

    setTimeout(() => {
      pulse();
      setInterval(pulse, 1000);
    }, 500);

    function animate(now) {
      frame += 1;
      const w = window.innerWidth;
      const h = window.innerHeight;
      sweep.style.transform = 'translateX(' + (((now / 6) % (w + 300)) - 220) + 'px)';
      ticker.style.transform = 'translateX(' + (-((now / 10) % Math.max(1, w))) + 'px)';
      dot.style.transform =
        'translate(' +
        ((Math.sin(now / 620) * 0.42 + 0.5) * (w - 140)) +
        'px,' +
        ((Math.cos(now / 780) * 0.36 + 0.5) * (h - 140)) +
        'px)';
      counter.textContent = 'sync ' + String(count).padStart(4, '0') + ' frame ' + String(frame).padStart(6, '0');
      requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
  </script>
</body>
</html>`
}
