import type { Locator, Page } from "playwright";

export type PickerKind = "model" | "effort";

const menuItems = '[role="menuitem"], [role="menuitemradio"], [role="option"], [role="radio"]';
// Only show choices of the requested kind: ChatGPT can render model and
// reasoning controls in the same visible menu.
const modelChoice = /^(?:chatgpt\s+)?gpt[\s\-‐‑‒–—−]*\d/i;
const effortChoice = /^(?:low|medium|high|низк(?:ий|ая|ое|ие)|средн(?:ий|яя|ее|ие)|высок(?:ий|ая|ое|ие))$/i;
const effortButtonLabel = /^(?:thinking effort|reasoning effort|уровень рассуждений|усилие мышления)$/i;

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
  const composer = await visibleButton(page, [
    '#prompt-textarea', 'div[contenteditable="true"][data-lexical-editor="true"]',
    'div[contenteditable="true"][role="textbox"]', 'textarea[data-id="root"]',
  ]);
  const composerBox = await composer?.boundingBox().catch(() => null);
  let closest: { locator: Locator; distance: number } | undefined;
  for (let i = 0; i < await buttons.count(); i++) {
    const button = buttons.nth(i);
    if (!(await button.isVisible().catch(() => false))) continue;
    const label = (await button.innerText().catch(() => "")).trim().split("\n")[0]?.trim() ?? "";
    if (!effortChoice.test(label) && !effortButtonLabel.test(label)) continue;
    const box = await button.boundingBox().catch(() => null);
    if (!box) continue;
    if (!composerBox) {
      if (effortButtonLabel.test(label)) return button;
      continue;
    }
    const distance = Math.abs((box.y + box.height / 2) - (composerBox.y + composerBox.height / 2));
    if (distance <= 100 && (!closest || distance < closest.distance)) closest = { locator: button, distance };
  }
  return closest?.locator;
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

interface SliderState { min: number; max: number; value: number; text?: string }

async function visibleEffortSlider(page: Page, button: Locator): Promise<Locator | undefined> {
  const candidates = page.locator('[role="slider"], input[type="range"]');
  const buttonBox = await button.boundingBox().catch(() => null);
  if (!buttonBox) return undefined;
  const visible: Locator[] = [];
  for (let index = 0; index < await candidates.count(); index += 1) {
    const slider = candidates.nth(index);
    if (!(await slider.isVisible().catch(() => false)) || await slider.isDisabled().catch(() => true)) continue;
    const box = await slider.boundingBox().catch(() => null);
    if (!box) continue;
    const x = box.x + box.width / 2 - (buttonBox.x + buttonBox.width / 2);
    const y = box.y + box.height / 2 - (buttonBox.y + buttonBox.height / 2);
    if (Math.abs(x) <= 250 && Math.abs(y) <= 200) visible.push(slider);
  }
  // Do not operate an unrelated slider when the page exposes several.
  return visible.length === 1 ? visible[0] : undefined;
}

async function sliderState(slider: Locator): Promise<SliderState | undefined> {
  return slider.evaluate((element) => {
    const input = element instanceof HTMLInputElement ? element : undefined;
    const minText = element.getAttribute("aria-valuemin") ?? (input ? input.min || "0" : "");
    const maxText = element.getAttribute("aria-valuemax") ?? (input ? input.max || "100" : "");
    const valueText = element.getAttribute("aria-valuenow") ?? input?.value ?? "";
    if (!minText || !maxText || !valueText) return undefined;
    const min = Number(minText);
    const max = Number(maxText);
    const value = Number(valueText);
    if (![min, max, value].every(Number.isFinite) || max <= min || value < min || value > max) return undefined;
    return { min, max, value, text: element.getAttribute("aria-valuetext") ?? undefined };
  }).catch(() => undefined);
}

async function moveSlider(slider: Locator, target: number, bounds: SliderState): Promise<void> {
  const tolerance = Math.max(1e-7, (bounds.max - bounds.min) * 1e-7);
  let state = await sliderState(slider);
  if (!state) throw new Error("ChatGPT's effort slider does not expose its current value.");
  if (Math.abs(state.value - target) <= tolerance) return;
  await slider.focus();
  if (Math.abs(target - bounds.max) <= tolerance) {
    await slider.press("End");
    state = await sliderState(slider);
    if (state && Math.abs(state.value - target) <= tolerance) return;
  }
  await slider.press("Home");
  state = await sliderState(slider);
  if (!state || Math.abs(state.value - bounds.min) > tolerance) throw new Error("ChatGPT's effort slider could not be positioned safely.");
  for (let index = 0; index < 200 && state.value < target - tolerance; index += 1) {
    const previous = state.value;
    await slider.press("ArrowRight");
    state = await sliderState(slider);
    if (!state || state.value <= previous || state.value > target + tolerance) throw new Error("ChatGPT's effort slider does not have the expected discrete levels.");
  }
  if (Math.abs(state.value - target) > tolerance) throw new Error("Could not reach the requested thinking effort.");
}

async function checkSliderStep(slider: Locator, original: SliderState, target: number): Promise<void> {
  const tolerance = Math.max(1e-7, (original.max - original.min) * 1e-7);
  if (Math.abs(original.value - target) <= tolerance) return;
  await slider.focus();
  const forward = original.value < original.max - tolerance;
  await slider.press(forward ? "ArrowRight" : "ArrowLeft");
  const probe = await sliderState(slider);
  if (!probe || Math.abs(probe.value - original.value) <= tolerance) throw new Error("ChatGPT's effort slider cannot be controlled with the keyboard.");
  const step = Math.abs(probe.value - original.value);
  await slider.press(forward ? "ArrowLeft" : "ArrowRight");
  const restored = await sliderState(slider);
  if (!restored || Math.abs(restored.value - original.value) > tolerance) throw new Error("Could not restore the original effort after inspecting the slider. Check it in ChatGPT.");
  const stepsToTarget = (target - original.min) / step;
  const stepsToOriginal = (original.value - original.min) / step;
  if (stepsToTarget > 200 || stepsToOriginal > 200 || Math.abs(stepsToTarget - Math.round(stepsToTarget)) * step > tolerance) {
    throw new Error("ChatGPT's effort slider does not expose the expected three levels.");
  }
}

async function readEffortSlider(slider: Locator, select?: string): Promise<{ choices: string[]; selected?: string }> {
  const state = await sliderState(slider);
  if (!state) throw new Error("ChatGPT's effort slider has no readable value or range.");
  const choices = ["Low", "Medium", "High"];
  if (select === undefined) return { choices };
  const needle = select.trim().toLocaleLowerCase();
  const matches = choices.filter((choice) => choice.toLocaleLowerCase() === needle);
  if (matches.length !== 1) throw new Error(`"${select}" is unavailable. Use /effort to see the current options.`);
  const index = choices.indexOf(matches[0]!);
  const target = state.min + (state.max - state.min) * index / 2;
  try {
    await checkSliderStep(slider, state, target);
    await moveSlider(slider, target, state);
    const actual = await sliderState(slider);
    if (actual?.text && effortChoice.test(actual.text.trim())) {
      const level = /^(?:low|низк)/i.test(actual.text) ? 0 : /^(?:medium|средн)/i.test(actual.text) ? 1 : 2;
      if (level !== index) throw new Error("ChatGPT reported a different thinking effort after selection.");
    }
  } catch (error) {
    // If selection was interrupted or rejected, restore the original value.
    await moveSlider(slider, state.value, state).catch(() => undefined);
    throw error;
  }
  return { choices, selected: matches[0] };
}

export async function readPicker(page: Page, kind: PickerKind, select?: string): Promise<{ choices: string[]; selected?: string }> {
  const button = await pickerButton(page, kind);
  if (!button) throw new Error(`The ${kind} control was not found in ChatGPT. Its availability depends on the model and account.`);
  let selected: string | undefined;
  try {
    await button.click();
    await page.waitForTimeout(300);
    if (kind === "effort") {
      const slider = await visibleEffortSlider(page, button);
      if (slider) return await readEffortSlider(slider, select);
    }
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
    await page.keyboard.press("Escape").catch(() => undefined);
  }
}
