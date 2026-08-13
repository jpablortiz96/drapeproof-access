import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const baseUrl = process.env.DRAPEPROOF_PUBLIC_URL ?? "https://drapeproof-access.vercel.app";
if (new URL(baseUrl).protocol !== "https:") throw new Error("Production browser QA requires an HTTPS URL.");
const outputRoot = resolve(process.cwd(), "../.tmp/production-browser-qa");
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const forbidden = /\b(?:judge|hackathon|milestone|M\d+(?:\.\d+)?|(?:internal\s+)?replay\s+mode)\b/i;
const errors = [];
const states = [];

await mkdir(outputRoot, { recursive: true });
const browser = await chromium.launch({ executablePath: edge, headless: true });
const context = await browser.newContext({ reducedMotion: "reduce", colorScheme: "dark" });
const routes = [
  ["home-mobile", "/", "Try the look", 390, 844],
  ["try-mobile", "/try", "A preview that checks what matters", 390, 844],
  ["how-tablet", "/how-it-works", "A try-on should change", 768, 1024],
  ["privacy-mobile", "/privacy", "Your images deserve", 390, 844],
  ["home-desktop", "/", "Try the look", 1440, 1000],
  ["not-found", "/result?id=00000000-0000-4000-8000-000000000000", "This result is no longer available", 390, 844],
];

try {
  for (const [name, path, expected, width, height] of routes) {
    const page = await context.newPage();
    await page.setViewportSize({ width, height });
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      if (name === "not-found" && /Failed to load resource:.*status of 404/i.test(message.text())) return;
      errors.push(`${path}: ${message.text()}`);
    });
    page.on("pageerror", (error) => errors.push(`${path}: ${error.message}`));
    const response = await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    if (!response?.ok()) throw new Error(`${path} returned ${response?.status()}.`);
    await page.getByText(expected, { exact: false }).first().waitFor({ timeout: 20_000 });
    const metrics = await page.evaluate(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const smallTargets = [...document.querySelectorAll("a,button,input:not([type=range]),summary")].filter((element) => {
        if (!visible(element) || element.classList.contains("visually-hidden") || element.closest("label") && element.tagName === "INPUT") return false;
        const rect = element.getBoundingClientRect(); return rect.width < 48 || rect.height < 48;
      }).map((element) => ({ tag: element.tagName, label: (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 50) }));
      return {
        bodyText: document.body.innerText,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        main: document.querySelectorAll("main#main").length,
        headings: document.querySelectorAll("h1").length,
        unlabeledImages: [...document.images].filter((image) => !image.hasAttribute("alt")).length,
        duplicateIds: [...document.querySelectorAll("[id]")].map((item) => item.id).filter((id, index, all) => all.indexOf(id) !== index),
        smallTargets,
      };
    });
    if (forbidden.test(metrics.bodyText)) throw new Error(`${path} exposes milestone or evaluator language.`);
    if (metrics.overflow > 0 || metrics.main !== 1 || metrics.headings !== 1 || metrics.unlabeledImages || metrics.duplicateIds.length || metrics.smallTargets.length) {
      throw new Error(`${path} accessibility/layout regression: ${JSON.stringify({ ...metrics, bodyText: undefined })}`);
    }
    const headers = response.headers();
    if (!headers["content-security-policy"] || headers["x-content-type-options"] !== "nosniff" || !headers["referrer-policy"] || !headers["permissions-policy"] || headers["x-frame-options"] !== "DENY") {
      throw new Error(`${path} is missing production security headers.`);
    }
    if (/^\/(?:try|result)/.test(path) && (!/no-(?:store|cache)/.test(headers["cache-control"] ?? "") || !/noindex/.test(headers["x-robots-tag"] ?? ""))) {
      throw new Error(`${path} is missing private cache/noindex headers.`);
    }
    if (["home-mobile", "try-mobile", "privacy-mobile", "home-desktop"].includes(name)) {
      await page.screenshot({ path: resolve(outputRoot, `${name}-${width}x${height}.png`), fullPage: false, animations: "disabled" });
    }
    states.push({ name, path, viewport: `${width}x${height}`, overflow: metrics.overflow, headings: metrics.headings, securityHeaders: "PASS", forbiddenLanguage: "PASS" });
    await page.close();
  }

  const keyboard = await context.newPage();
  await keyboard.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await keyboard.keyboard.press("Tab");
  const focus = await keyboard.evaluate(() => ({ href: document.activeElement?.getAttribute("href") }));
  if (focus.href !== "#main") throw new Error(`Skip link was not the first focus target: ${JSON.stringify(focus)}`);
  await keyboard.close();

  const media = await context.request.get(`${baseUrl}/api/sessions/00000000-0000-4000-8000-000000000000/asset/source`);
  if (media.status() !== 404 || !/private.*no-store/.test(media.headers()["cache-control"] ?? "")) {
    throw new Error("Unauthenticated private-media response was not a private 404.");
  }
  const health = await context.request.get(`${baseUrl}/api/health`);
  if (health.status() !== 200 || (await health.json()).status !== "ok") throw new Error("Production health was not ready during browser QA.");
} finally {
  await context.close();
  await browser.close();
}

if (errors.length) throw new Error(`Console errors:\n${errors.join("\n")}`);
const report = { browser: "Microsoft Edge (Chromium)", baseUrl, providerCalls: 0, states, keyboard: { skipLink: "PASS" }, privateMedia: "PASS", health: "PASS", consoleErrors: errors };
await writeFile(resolve(outputRoot, "browser-qa.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`PASS ${states.length} public responsive states, accessibility, headers, noindex, private-media, language, and console checks; provider calls: 0.`);
