import { chromium } from "playwright";
import { expect, it } from "vitest";
import { readPicker } from "../src/browser/picker.js";
import { PICKER_PAGE } from "./fixtures/picker-page.js";

it("selects a model under an overlapping effort toggle, confirms it and closes every menu layer", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.setContent(PICKER_PAGE);
    expect(await readPicker(page, "model", "GPT-6")).toMatchObject({ selected: "GPT-6", confirmed: true });
    expect(await page.evaluate(() => (window as unknown as { wrongHits: number }).wrongHits)).toBe(0);
    expect(await page.locator('#effort-menu').isVisible()).toBe(false);
    expect(await page.locator('#models').isVisible()).toBe(false);
    expect(await readPicker(page, "effort", "High")).toMatchObject({ selected: "High" });
    expect(await page.locator('#effort').innerText()).toBe("High");
    expect(await page.locator('#effort-menu').isVisible()).toBe(false);
    // Repeated reads and already-selected choices must not toggle menus closed
    // during confirmation, or accidentally click the overlaid High control.
    expect(await readPicker(page, "model", "GPT-6")).toMatchObject({ selected: "GPT-6", confirmed: true });
    expect(await page.evaluate(() => (window as unknown as { wrongHits: number }).wrongHits)).toBe(0);
  } finally { await browser.close(); }
}, 20_000);

it("reacquires controls when the effort trigger is replaced during startup", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.setContent(PICKER_PAGE);
    await page.evaluate(() => {
      const original = document.querySelector<HTMLButtonElement>('#effort')!;
      const clone = original.cloneNode(true) as HTMLButtonElement;
      original.onpointerdown = () => { original.replaceWith(clone); clone.onclick = () => { document.querySelector<HTMLElement>('#effort-menu')!.hidden = false; clone.setAttribute('aria-expanded','true'); }; };
    });
    expect(await readPicker(page, "model", "GPT-6")).toMatchObject({ selected: "GPT-6", confirmed: true });
  } finally { await browser.close(); }
}, 20_000);
