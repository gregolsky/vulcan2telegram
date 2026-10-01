import { chromium } from 'playwright';
import { USERNAME, PASSWORD, PORTAL_URL, CHROMIUM_PATH } from './config.mjs';

/** Headless browser logged in to Vulcan. Modules share one session per run. */
export async function openSession() {
  const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM_PATH });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(PORTAL_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.fill('#Username', USERNAME);
    await page.fill('#Password', PASSWORD);
    await page.click('button:has-text("ZALOGUJ")');
    await page.waitForTimeout(5000);
    if (page.url().includes('LoginPage')) {
      throw new Error('Vulcan login failed — wrong or expired password?');
    }
    return { ctx, page, close: () => browser.close() };
  } catch (e) {
    await browser.close();
    throw e;
  }
}
