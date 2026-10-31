import type { Locator, Page } from "playwright";

export type PickerKind = "model" | "effort";

const menuItems = '[role="menuitem"], [role="menuitemradio"], [role="option"], [role="radio"]';
// Only show choices of the requested kind: ChatGPT can render model and
// reasoning controls in the same visible menu.
const modelChoice = /^(?:chatgpt\s+)?gpt[\s\-‐‑‒–—−]*\d/i;
const effortChoice = /^(?:low|medium|high|низк(?:ий|ая|ое|ие)|средн(?:ий|яя|ее|ие)|высок(?:ий|ая|ое|ие))$/i;

async function visibleButton(page: Page, selectors: string[]): Promise<Locator | undefined> {
  for (const selector of selectors) {
    const matches = page.locator(selector);
    for (let i = 0; i < await matches.count(); i++) {
      const item = matches.nth(i);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return undefined;
}

async function pickerButton(page: Page, kind: PickerKind): Promise<Locator | undefined> {
  if (kind === "model") return visibleButton(page, [
    '[data-testid="model-switcher-dropdown-button"]',
    'button[aria-label*="model" i]',
    'button[aria-label*="модел" i]',
  ]);
  const explicit = await visibleButton(page, [
    'button[data-testid*="reasoning" i]', 'button[data-testid*="effort" i]',
    'button[aria-label*="thinking effort" i]', 'button[aria-label*="reasoning" i]',
    'button[aria-label*="уровень рассуждений" i]',
  ]);
  if (explicit) return explicit;
  const buttons = page.locator('button[aria-haspopup="menu"], button[aria-haspopup="listbox"], button');
  const viewport = page.viewportSize();
  for (let i = 0; i < await buttons.count(); i++) {
    const button = buttons.nth(i);
    if (!(await button.isVisible().catch(() => false))) continue;
    const label = (await button.innerText().catch(() => "")).trim().split("\n")[0]?.trim() ?? "";
    if (!effortChoice.test(label)) continue;
    const box = await button.boundingBox().catch(() => null);
    if (box && (!viewport || box.y >= viewport.height / 2)) return button;
  }
  return undefined;
}

interface MenuItem { label: string; locator: Locator; submenu: boolean }
interface Choice { label: string; route: string[] }

async function items(page: Page): Promise<MenuItem[]> {
  const menus = page.locator('[role="menu"], [role="listbox"]');
  let scope: Locator | undefined;
  for (let i = 0; i < await menus.count(); i++) {
    const menu = menus.nth(i);
    if (await menu.isVisible().catch(() => false)) scope = menu;
  }
  const locators = scope ? scope.locator(menuItems) : page.locator(menuItems);
  const result: MenuItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < await locators.count(); i++) {
    const locator = locators.nth(i);
    if (!(await locator.isVisible().catch(() => false)) || await locator.isDisabled().catch(() => false)) continue;
    const label = ((await locator.innerText().catch(() => "")).trim().split("\n")[0] || await locator.getAttribute("aria-label") || "").trim();
    if (!label || label.length > 120 || seen.has(label.toLocaleLowerCase())) continue;
    seen.add(label.toLocaleLowerCase());
    const popup = await locator.getAttribute("aria-haspopup");
    result.push({ label, locator, submenu: popup === "menu" || popup === "listbox" || popup === "true" });
  }
  return result;
}

async function collectChoices(page: Page, kind: PickerKind, route: string[] = [], depth = 0): Promise<Choice[]> {
  const result: Choice[] = [];
  const menu = await items(page);
  for (const item of menu) {
    const next = [...route, item.label];
    if (!item.submenu) {
      if ((kind === "model" ? modelChoice : effortChoice).test(item.label)) result.push({ label: item.label, route: next });
      continue;
    }
    if (kind === "effort" && modelChoice.test(item.label)) continue;
    if (depth >= 2) continue;
    await item.locator.click();
    await page.waitForTimeout(200);
    try { result.push(...await collectChoices(page, kind, next, depth + 1)); }
    finally { await page.keyboard.press("Escape").catch(() => undefined); }
  }
  return result;
}

async function chooseRoute(page: Page, route: string[]): Promise<void> {
  for (let index = 0; index < route.length; index++) {
    const menu = await items(page);
    const item = menu.find((choice) => choice.label === route[index]);
    if (!item || (index < route.length - 1 && !item.submenu)) throw new Error("ChatGPT's menu changed. Open the list again before choosing.");
    await item.locator.click();
    if (index < route.length - 1) await page.waitForTimeout(200);
  }
}

export async function readPicker(page: Page, kind: PickerKind, select?: string): Promise<{ choices: string[]; selected?: string }> {
  const button = await pickerButton(page, kind);
  if (!button) throw new Error(`The ${kind} control was not found in ChatGPT. Its availability depends on the model and account.`);
  let selected: string | undefined;
  try {
    await button.click();
    await page.waitForTimeout(300);
    const found = await collectChoices(page, kind);
    const counts = new Map<string, number>();
    for (const choice of found) counts.set(choice.label.toLocaleLowerCase(), (counts.get(choice.label.toLocaleLowerCase()) ?? 0) + 1);
    const choices = found.map((choice) => counts.get(choice.label.toLocaleLowerCase()) === 1 ? choice : { ...choice, label: choice.route.join(" › ") });
    if (!choices.length) throw new Error(`The ${kind} menu contains no available options.`);
    if (select !== undefined) {
      const needle = select.trim().toLocaleLowerCase();
      const exact = choices.filter((choice) => choice.label.toLocaleLowerCase() === needle || choice.route.join(" › ").toLocaleLowerCase() === needle);
      const matches = exact.length ? exact : choices.filter((choice) => choice.label.toLocaleLowerCase().includes(needle));
      if (matches.length !== 1) throw new Error(matches.length ? `More than one ${kind} matches "${select}"; choose a number from /${kind}.` : `"${select}" is unavailable. Use /${kind} to see the current options.`);
      await chooseRoute(page, matches[0]!.route);
      selected = matches[0]!.label;
      await page.waitForTimeout(200);
    }
    return { choices: choices.map((choice) => choice.label), selected };
  } finally {
    if (!selected) await page.keyboard.press("Escape").catch(() => undefined);
  }
}
