import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1280, height: 900 });
await page.goto('http://localhost:5000/login');
await page.waitForLoadState('networkidle');
await page.fill('input[type="text"], input[name="username"]', 'ben.beddes@valuetruck.com');
await page.fill('input[type="password"]', 'Shipping123!');
await page.click('button[type="submit"]');
await page.waitForTimeout(3000);
await page.screenshot({ path: '/tmp/sidebar_new.png', clip: { x: 0, y: 0, width: 232, height: 860 } });
console.log('Screenshot saved to /tmp/sidebar_new.png');
await browser.close();
