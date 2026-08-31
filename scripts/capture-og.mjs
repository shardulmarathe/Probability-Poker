// Build-time OpenGraph capture: screenshots the LIVE homepage and writes it to
// dist/og.png, so the link preview always shows the current site with no manual
// work. Runs after `vite build` (see package.json) against a local `vite preview`
// server (this is a static SPA with no server runtime). Resilient: on any
// failure it warns and exits 0 (never blocks the deploy), the committed
// public/og.png (copied to dist/og.png by vite build) stays as the fallback.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = process.env.OG_OUT || join(ROOT, "dist", "og.png");

const PORT = Number(process.env.OG_PORT || 4319);
const URL = `http://localhost:${PORT}/`;
// Fonts and the felt gradient still have to arrive; there are no animations
// left to wait out (see the reduced-motion note below), so this is shorter than
// it was and is about loading rather than about motion.
const SETTLE_MS = Number(process.env.OG_SETTLE_MS || 1500);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * How much of the image has to move before the new one is worth keeping.
 *
 * Software rendering of the felt's radial gradient is not bit-exact, so two
 * captures of an unchanged homepage differ in a handful of pixels. The refresh
 * workflow committed on every push because a byte comparison counts that as a
 * change, and the commit it makes is what rejects the next push.
 *
 * All three numbers below are measured rather than chosen, on captures of this
 * homepage at 1200x630 and a device scale of 2, so 3,024,000 pixels:
 *
 *   noise floor        0.0043%  (131 pixels, and the same 131 twice over)
 *   max channel delta  7 of 255
 *   a one-word edit    0.26%    ("learns" to "studies" in the hero)
 *
 * So the fraction sits about 23 times above the floor and about a quarter of
 * the smallest content change worth catching, and the tolerance sits one step
 * above the observed delta so gradient dither is not counted at all. A change
 * subtler than a word may fall under it, which is the right way round: a
 * slightly stale preview costs less than a commit on every push. Re-measure
 * before retuning, the floor is renderer-specific and a CI runner is not this
 * machine.
 */
const DIFF_TOLERANCE = 8;
const DIFF_FRACTION = 0.001;

/**
 * Fraction of pixels that differ beyond `DIFF_TOLERANCE`, or 1 when the two
 * cannot be compared (different sizes, an unreadable file), because "cannot
 * tell" has to mean "keep the new one" rather than silently keeping a stale
 * image.
 */
async function changedFraction(browser, before, after) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(
      async (aSrc, bSrc, tolerance) => {
        const load = (src) =>
          new Promise((ok, no) => {
            const img = new Image();
            img.onload = () => ok(img);
            img.onerror = no;
            img.src = src;
          });
        const [a, b] = await Promise.all([load(aSrc), load(bSrc)]);
        if (a.width !== b.width || a.height !== b.height) return 1;
        const pixels = (img) => {
          const canvas = new OffscreenCanvas(img.width, img.height);
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          return ctx.getImageData(0, 0, img.width, img.height).data;
        };
        const [pa, pb] = [pixels(a), pixels(b)];
        let differing = 0;
        for (let i = 0; i < pa.length; i += 4) {
          const delta = Math.max(
            Math.abs(pa[i] - pb[i]),
            Math.abs(pa[i + 1] - pb[i + 1]),
            Math.abs(pa[i + 2] - pb[i + 2])
          );
          if (delta > tolerance) differing++;
        }
        return differing / (pa.length / 4);
      },
      // `Buffer.from` on both, deliberately: a screenshot comes back as a
      // Uint8Array, whose `toString("base64")` ignores the argument and returns
      // comma-separated byte values. That is not a data URL, the image fails to
      // load, and the comparison reports every pixel changed.
      `data:image/png;base64,${Buffer.from(before).toString("base64")}`,
      `data:image/png;base64,${Buffer.from(after).toString("base64")}`,
      DIFF_TOLERANCE
    );
  } catch {
    return 1;
  } finally {
    await page.close();
  }
}

async function waitForServer(url, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok || res.status === 404) return true;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  return false;
}

async function main() {
  const viteBin = join(ROOT, "node_modules", ".bin", "vite");
  if (!existsSync(viteBin) || !existsSync(join(ROOT, "dist", "index.html"))) {
    console.warn("[og] vite binary or dist/ missing — skipping capture");
    return;
  }

  const server = spawn(
    viteBin,
    ["preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: ROOT, detached: true, stdio: "ignore", env: { ...process.env } },
  );
  const killServer = () => {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  };

  try {
    const up = await waitForServer(URL);
    if (!up) {
      console.warn("[og] preview server did not become ready — skipping capture");
      return;
    }

    const { default: puppeteer } = await import("puppeteer");
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-webgl",
        "--ignore-gpu-blocklist",
        "--hide-scrollbars",
        "--force-color-profile=srgb",
      ],
    });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 2 });
      /*
       * Reduced motion, so the capture is reproducible.
       *
       * This asked for `no-preference` and then slept, which is the reason the
       * refresh workflow committed a new screenshot on every push whether the
       * homepage had changed or not. `.pp-float` on the hero cards is a five
       * second infinite loop, so a fixed sleep lands at an arbitrary phase and
       * the cards sit a few pixels apart in consecutive captures; the bytes
       * differ, `git diff --cached --quiet` sees a change, and the bot commits.
       *
       * `src/index.css` already answers `prefers-reduced-motion: reduce` by
       * setting `animation: none` and `opacity: 1` on every animated class, so
       * asking for it here freezes the page at its resting state with nothing
       * hidden. Two captures of an unchanged homepage are then byte-identical
       * and the workflow's existing guard does what it says.
       */
      await page.emulateMediaFeatures([
        { name: "prefers-reduced-motion", value: "reduce" },
      ]);
      await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
      /*
       * Wait for the webfonts, not just for the network.
       *
       * `networkidle2` plus a sleep is not enough on a cold cache: the first
       * capture in a fresh environment came out different from the second and
       * third, which were identical to each other, because the display face had
       * not finished swapping in. Every CI run is a cold cache, so that first
       * capture is the only one CI ever takes. `document.fonts.ready` resolves
       * when every face the page uses has loaded or failed, which is the actual
       * condition, and it is awaited before the settle rather than instead of
       * it because the felt gradient is still worth a moment.
       */
      await page.evaluate(() => document.fonts.ready);
      await sleep(SETTLE_MS);
      const shot = await page.screenshot({ type: "png" });

      /*
       * Only overwrite on a real change, so the refresh workflow's own
       * "commit if it changed" guard means what it says. Writing every time
       * makes that guard a no-op and every push produces a bot commit.
       */
      if (existsSync(OUT)) {
        const fraction = await changedFraction(browser, readFileSync(OUT), shot);
        if (fraction < DIFF_FRACTION) {
          console.log(
            `[og] homepage unchanged (${(fraction * 100).toFixed(4)}% of pixels moved) -> keeping ${OUT}`
          );
          return;
        }
        console.log(`[og] homepage changed (${(fraction * 100).toFixed(2)}% of pixels)`);
      }

      writeFileSync(OUT, shot);
      console.log(`[og] captured homepage -> ${OUT}`);
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.warn(`[og] capture failed (${err?.message}); keeping existing og.png`);
  } finally {
    killServer();
  }
}

await main();
process.exit(0);
