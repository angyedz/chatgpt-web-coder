import type { Locator, Page } from "playwright";
import { withBrowserUi } from "./ui-queue.js";

export type PickerKind = "model" | "effort";
export class PickerPreparationError extends Error {}

export async function dismissPickerMenus(page: Page): Promise<void> {
  // Escape dismisses one Radix layer at a time: model submenu, effort popover,
  // then the outer picker. Always leave a clean composer for the next action.
  for (let layer = 0; layer < 4; layer++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(60);
  }
}

async function clickControl(locator: Locator, expected?: string): Promise<void> {
  // Model rows can contain an effort control over their centre. Choose a hit
  // point belonging to this control, excluding nested interactive controls.
  const position = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    for (const y of [0.35, 0.5, 0.65]) for (const x of [0.12, 0.25, 0.5, 0.75, 0.88]) {
      const px = box.left + box.width * x;
      const py = box.top + box.height * y;
      const hit = document.elementFromPoint(px, py);
      if (!hit || !element.contains(hit)) continue;
      let nested: Element | null = hit;
      while (nested && nested !== element && !nested.matches('button, a, input, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"]')) nested = nested.parentElement;
      if (nested && nested !== element) continue;
      return { x: px, y: py };
    }
    return undefined;
  }, undefined, { timeout: 1_500 });
  if (!position) throw new Error(`The ${expected ?? "picker"} control is covered or no longer available.`);
  if (expected) {
    const actual = (await locator.innerText({ timeout: 1_500 })).trim().split("\n")[0]?.trim();
    if (actual && actual !== expected) throw new Error("The picker changed before selection; retry with fresh controls.");
  }
  // Use the verified visible hit point directly. Playwright's click stability
  // wait depends on animation frames, which background CDP tabs can suspend.
  // This remains a real pointer click; no forced click or scripted event.
  await locator.page().mouse.click(position.x, position.y);
}

async function isSelected(locator: Locator): Promise<boolean> {
  return (await Promise.all(["aria-checked", "aria-selected", "aria-pressed", "data-model-selected"].map((name) => locator.getAttribute(name, { timeout: 1_500 })))).includes("true")
    || await locator.getAttribute("data-state", { timeout: 1_500 }) === "checked";
}

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
  if (kind === "model") {
    const candidates = page.locator('[data-testid="model-switcher-dropdown-button"], button[aria-label*="model" i], button[aria-label*="модел" i]');
    for (let index = 0; index < await candidates.count(); index++) {
      const candidate = candidates.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const label = (await candidate.innerText({ timeout: 1_500 }).catch(() => "")).trim().split("\n")[0]?.trim() ?? "";
      // A combined "model and effort" label still opens the effort popover;
      // it is not the old direct model switcher, even if its aria-label matches.
      if (effortChoice.test(label) || effortButtonLabel.test(label)) continue;
      return candidate;
    }
    return undefined;
  }
  const explicit = await visibleButton(page, [
    'button[data-testid*="reasoning" i]', 'button[data-testid*="effort" i]',
    'button[aria-label*="thinking effort" i]', 'button[aria-label*="reasoning" i]',
    'button[aria-label*="уровень рассуждений" i]',
  ]);
  if (explicit) return explicit;
  const buttons = page.locator('button, [role="button"]');
  const composer = await visibleButton(page, [
    '#prompt-textarea', 'div[contenteditable="true"][data-lexical-editor="true"]',
    'div[contenteditable="true"][role="textbox"]', 'textarea[data-id="root"]',
  ]);
  const composerBox = await composer?.boundingBox({ timeout: 1_500 }).catch(() => null);
  let closest: { locator: Locator; distance: number } | undefined;
  for (let i = 0; i < await buttons.count(); i++) {
    const button = buttons.nth(i);
    if (!(await button.isVisible().catch(() => false))) continue;
    const label = (await button.innerText({ timeout: 1_500 }).catch(() => "")).trim().split("\n")[0]?.trim() ?? "";
    if (!effortChoice.test(label) && !effortButtonLabel.test(label)) continue;
    const box = await button.boundingBox({ timeout: 1_500 }).catch(() => null);
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

async function waitForPickerButton(page: Page, kind: PickerKind, timeoutMs = 8_000): Promise<Locator | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const button = await pickerButton(page, kind);
    if (button) return button;
    await page.waitForTimeout(200);
  } while (Date.now() < deadline);
  return undefined;
}

interface MenuItem { label: string; locator: Locator; submenu: boolean }
interface Choice { label: string; route: string[] }
interface PickerOrigin { x: number; y: number }

async function items(page: Page, modelOrigin?: PickerOrigin): Promise<MenuItem[]> {
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
    const label = ((await locator.innerText({ timeout: 1_500 }).catch(() => "")).trim().split("\n")[0] || await locator.getAttribute("aria-label", { timeout: 1_500 }) || "").trim();
    if (!label || label.length > 120 || seen.has(label.toLocaleLowerCase())) continue;
    seen.add(label.toLocaleLowerCase());
    const popup = await locator.getAttribute("aria-haspopup", { timeout: 1_500 });
    result.push({ label, locator, submenu: popup === "menu" || popup === "listbox" || popup === "true" });
  }
  // Some ChatGPT popovers render model choices as buttons rather than ARIA
  // menu items. Only consider model-labelled controls near the opened picker.
  if (modelOrigin) {
    // ChatGPT renders the model submenu in a separate popover. It is often a
    // sibling of the effort menu, so limiting this scan to the last visible
    // [role=menu] silently drops the actual model choices.
    const buttons = page.locator('button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"]');
    for (let index = 0; index < await buttons.count(); index += 1) {
      const locator = buttons.nth(index);
      if (!(await locator.isVisible().catch(() => false)) || await locator.isDisabled().catch(() => false)) continue;
      const label = ((await locator.innerText({ timeout: 1_500 }).catch(() => "")).trim().split("\n")[0] || await locator.getAttribute("aria-label", { timeout: 1_500 }) || "").trim();
      if (!modelChoice.test(label) || label.length > 120 || seen.has(label.toLocaleLowerCase())) continue;
      const box = await locator.boundingBox({ timeout: 1_500 }).catch(() => null);
      if (!box || Math.abs(box.x + box.width / 2 - modelOrigin.x) > 350 || Math.abs(box.y + box.height / 2 - modelOrigin.y) > 400) continue;
      seen.add(label.toLocaleLowerCase());
      const popup = await locator.getAttribute("aria-haspopup", { timeout: 1_500 });
      result.push({ label, locator, submenu: popup === "menu" || popup === "listbox" || popup === "true" });
    }
  }
  return result;
}

async function collectChoices(page: Page, kind: PickerKind, route: string[] = [], depth = 0, modelOrigin?: PickerOrigin): Promise<Choice[]> {
  const result: Choice[] = [];
  const menu = await items(page, modelOrigin);
  for (const item of menu) {
    const next = [...route, item.label];
    if (!item.submenu || (kind === "model" && modelChoice.test(item.label))) {
      if ((kind === "model" ? modelChoice : effortChoice).test(item.label)) result.push({ label: item.label, route: next });
      continue;
    }
    if (kind === "effort" && modelChoice.test(item.label)) continue;
    if (depth >= 2) continue;
    await clickControl(item.locator, item.label);
    await page.waitForTimeout(200);
    try { result.push(...await collectChoices(page, kind, next, depth + 1, modelOrigin)); }
    finally { await page.keyboard.press("Escape").catch(() => undefined); }
  }
  return result;
}

async function chooseRoute(page: Page, route: string[], modelOrigin?: PickerOrigin): Promise<void> {
  for (let index = 0; index < route.length; index++) {
    const menu = await items(page, modelOrigin);
    const item = menu.find((choice) => choice.label === route[index]);
    if (!item || (index < route.length - 1 && !item.submenu)) throw new Error("ChatGPT's menu changed. Open the list again before choosing.");
    await clickControl(item.locator, item.label);
    if (index < route.length - 1) await page.waitForTimeout(200);
  }
}

async function waitForModelOptions(page: Page, origin: PickerOrigin): Promise<void> {
  const deadline = Date.now() + 3_500;
  do {
    if ((await items(page, origin)).some((item) => modelChoice.test(item.label) || item.submenu)) return;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  throw new Error("ChatGPT's model options have not mounted yet.");
}

async function openModelPicker(page: Page): Promise<PickerOrigin | undefined> {
  const direct = await pickerButton(page, "model");
  if (direct) {
    await clickControl(direct);
    await page.waitForTimeout(200);
    const box = await direct.boundingBox({ timeout: 1_500 }).catch(() => null);
    if (box) {
      const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await waitForModelOptions(page, origin);
      return origin;
    }
  }
  const effort = await waitForPickerButton(page, "effort");
  if (effort) {
    const box = await effort.boundingBox({ timeout: 1_500 }).catch(() => null);
    if (box) {
      const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      // Callers dismiss every layer first. Do not trust aria-expanded from a
      // trigger replaced during hydration or another tab's settings update.
      await clickControl(effort);
      await page.locator('[role="menu"], [role="listbox"], [role="slider"], input[type="range"]').filter({ visible: true }).first().waitFor({ state: "visible", timeout: 3_500 });
      if ((await items(page, origin)).some((item) => modelChoice.test(item.label))) return origin;
      const candidates = page.locator('button, [role="button"], [role="menuitem"], [role="menuitemradio"], [data-effort-only="true"]');
      let trigger: { locator: Locator; distance: number } | undefined;
      for (let index = 0; index < await candidates.count(); index += 1) {
        const locator = candidates.nth(index);
        if (!(await locator.isVisible().catch(() => false)) || await locator.isDisabled().catch(() => false)) continue;
        const text = ((await locator.innerText({ timeout: 1_500 }).catch(() => "")).trim().split("\n")[0] || await locator.getAttribute("aria-label", { timeout: 1_500 }) || "").trim().replace(/\s*[›→>]\s*$/, "");
        if (!effortChoice.test(text)) continue;
        const candidateBox = await locator.boundingBox({ timeout: 1_500 }).catch(() => null);
        if (!candidateBox) continue;
        const x = candidateBox.x + candidateBox.width / 2 - origin.x;
        const y = candidateBox.y + candidateBox.height / 2 - origin.y;
        const distance = Math.abs(x) + Math.abs(y);
        // Exclude the outer button itself, which can also be named Medium.
        if (Math.abs(y) > 10 && Math.abs(x) <= 250 && Math.abs(y) <= 200 && (!trigger || distance < trigger.distance)) trigger = { locator, distance };
      }
      if (trigger) {
        await clickControl(trigger.locator);
        await waitForModelOptions(page, origin);
        return origin;
      }
      await dismissPickerMenus(page);
    }
  }
  const model = await waitForPickerButton(page, "model");
  if (!model) return undefined;
  await clickControl(model);
  await page.waitForTimeout(300);
  const box = await model.boundingBox({ timeout: 1_500 }).catch(() => null);
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : undefined;
}

async function confirmModelSelection(page: Page, expected: string): Promise<boolean | undefined> {
  const normalized = expected.trim().toLocaleLowerCase();
  const modelButton = await pickerButton(page, "model");
  if (modelButton) {
    const label = ((await modelButton.innerText({ timeout: 1_500 }).catch(() => "")).trim().split("\n")[0] || await modelButton.getAttribute("aria-label", { timeout: 1_500 }) || "").trim().toLocaleLowerCase();
    if (label === normalized || label.includes(normalized)) return true;
  }
  await dismissPickerMenus(page);
  const origin = await openModelPicker(page);
  if (!origin) return undefined;
  const options = await items(page, origin);
  const match = options.find((option) => option.label.trim().toLocaleLowerCase() === normalized);
  if (!match) return undefined;
  if (await isSelected(match.locator)) return true;
  const checked = await match.locator.getAttribute("aria-checked", { timeout: 1_500 });
  const selected = await match.locator.getAttribute("aria-selected", { timeout: 1_500 });
  const pressed = await match.locator.getAttribute("aria-pressed", { timeout: 1_500 });
  const state = await match.locator.getAttribute("data-state", { timeout: 1_500 });
  if (checked === "true" || selected === "true" || pressed === "true" || state === "checked") return true;
  if (await match.locator.locator('[aria-checked="true"], [aria-selected="true"], [data-state="checked"]').count()) return true;
  if (checked === "false" || selected === "false" || pressed === "false" || state === "unchecked") return false;
  return undefined;
}

interface SliderState { min: number; max: number; value: number; text?: string }

async function visibleEffortSlider(page: Page, button: Locator): Promise<Locator | undefined> {
  const candidates = page.locator('[role="slider"], input[type="range"]');
  const buttonBox = await button.boundingBox({ timeout: 1_500 }).catch(() => null);
  if (!buttonBox) return undefined;
  const visible: Locator[] = [];
  for (let index = 0; index < await candidates.count(); index += 1) {
    const slider = candidates.nth(index);
    if (!(await slider.isVisible().catch(() => false)) || await slider.isDisabled().catch(() => true)) continue;
    const box = await slider.boundingBox({ timeout: 1_500 }).catch(() => null);
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
  }, undefined, { timeout: 1_500 }).catch(() => undefined);
}

async function moveSlider(slider: Locator, target: number, bounds: SliderState): Promise<void> {
  const tolerance = Math.max(1e-7, (bounds.max - bounds.min) * 1e-7);
  let state = await sliderState(slider);
  if (!state) throw new Error("ChatGPT's effort slider does not expose its current value.");
  if (Math.abs(state.value - target) <= tolerance) return;
  await slider.focus({ timeout: 1_500 });
  if (Math.abs(target - bounds.max) <= tolerance) {
    await slider.press("End", { timeout: 1_500 });
    state = await sliderState(slider);
    if (state && Math.abs(state.value - target) <= tolerance) return;
  }
  await slider.press("Home", { timeout: 1_500 });
  state = await sliderState(slider);
  if (!state || Math.abs(state.value - bounds.min) > tolerance) throw new Error("ChatGPT's effort slider could not be positioned safely.");
  for (let index = 0; index < 200 && state.value < target - tolerance; index += 1) {
    const previous = state.value;
    await slider.press("ArrowRight", { timeout: 1_500 });
    state = await sliderState(slider);
    if (!state || state.value <= previous || state.value > target + tolerance) throw new Error("ChatGPT's effort slider does not have the expected discrete levels.");
  }
  if (Math.abs(state.value - target) > tolerance) throw new Error("Could not reach the requested thinking effort.");
}

async function checkSliderStep(slider: Locator, original: SliderState, target: number): Promise<void> {
  const tolerance = Math.max(1e-7, (original.max - original.min) * 1e-7);
  if (Math.abs(original.value - target) <= tolerance) return;
  await slider.focus({ timeout: 1_500 });
  const forward = original.value < original.max - tolerance;
  await slider.press(forward ? "ArrowRight" : "ArrowLeft", { timeout: 1_500 });
  const probe = await sliderState(slider);
  if (!probe || Math.abs(probe.value - original.value) <= tolerance) throw new Error("ChatGPT's effort slider cannot be controlled with the keyboard.");
  const step = Math.abs(probe.value - original.value);
  await slider.press(forward ? "ArrowLeft" : "ArrowRight", { timeout: 1_500 });
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

export async function readPickerUnlocked(page: Page, kind: PickerKind, select?: string): Promise<{ choices: string[]; selected?: string; confirmed?: boolean }> {
  let selected: string | undefined;
  let confirmed: boolean | undefined;
  try {
    await dismissPickerMenus(page);
    let modelOrigin: PickerOrigin | undefined;
    let button: Locator | undefined;
    if (kind === "model") {
      modelOrigin = await openModelPicker(page);
      if (!modelOrigin) throw new Error("The model control was not found in ChatGPT. Open the thinking effort control to check its availability.");
    } else {
      button = await waitForPickerButton(page, kind);
      if (!button) throw new Error("The effort control was not found in ChatGPT. Its availability depends on the model and account.");
      await clickControl(button);
      await page.waitForTimeout(300);
    }
    if (kind === "effort") {
      const slider = await visibleEffortSlider(page, button!);
      if (slider) return await readEffortSlider(slider, select);
    }
    const found = await collectChoices(page, kind, [], 0, modelOrigin);
    const counts = new Map<string, number>();
    for (const choice of found) counts.set(choice.label.toLocaleLowerCase(), (counts.get(choice.label.toLocaleLowerCase()) ?? 0) + 1);
    const choices = found.map((choice) => counts.get(choice.label.toLocaleLowerCase()) === 1 ? choice : { ...choice, label: choice.route.join(" › ") });
    if (!choices.length) throw new Error(`The ${kind} menu contains no available options.`);
    if (select !== undefined) {
      const needle = select.trim().toLocaleLowerCase();
      const exact = choices.filter((choice) => choice.label.toLocaleLowerCase() === needle || choice.route.join(" › ").toLocaleLowerCase() === needle);
      const matches = exact.length ? exact : choices.filter((choice) => choice.label.toLocaleLowerCase().includes(needle));
      if (matches.length !== 1) throw new Error(matches.length ? `More than one ${kind} matches "${select}"; choose a number from /${kind}.` : `"${select}" is unavailable. Use /${kind} to see the current options.`);
      const current = (await items(page, modelOrigin)).find((item) => item.label === matches[0]!.route.at(-1));
      const alreadySelected = current && await isSelected(current.locator);
      if (!alreadySelected) await chooseRoute(page, matches[0]!.route, modelOrigin);
      selected = matches[0]!.label;
      await page.waitForTimeout(200);
      if (kind === "model") {
        confirmed = alreadySelected ? true : await confirmModelSelection(page, matches[0]!.route.at(-1)!);
        if (confirmed !== true) throw new Error(`ChatGPT did not confirm ${selected}. The message was not sent.`);
      }
    }
    return { choices: choices.map((choice) => choice.label), selected, confirmed };
  } finally {
    await dismissPickerMenus(page).catch(() => undefined);
  }
}

export async function preparePicker(page: Page, kind: PickerKind, select?: string, signal?: AbortSignal): ReturnType<typeof readPickerUnlocked> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    try { return await readPickerUnlocked(page, kind, select); }
    catch (error) {
      signal?.throwIfAborted();
      lastError = error;
      if (page.isClosed()) throw error;
      if (attempt < 2) await page.waitForTimeout(250);
    }
  }
  throw new PickerPreparationError(`Could not prepare ChatGPT ${kind}${select ? ` ${select}` : ""}. No message was sent. ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export function readPicker(page: Page, kind: PickerKind, select?: string): ReturnType<typeof readPickerUnlocked> {
  return withBrowserUi(page.context(), () => preparePicker(page, kind, select));
}
