import { describe, expect, it } from "vitest";
import { panelTitle, renderTelegramKeyboard, type TelegramUiState, type TelegramPanel } from "../src/telegram/ui.js";

function state(panel: TelegramPanel): TelegramUiState {
  return { panel, sessionMenu: [], sessionPage: 0, folderMenu: [], folderPage: 0,
    modelOptions: [], effortOptions: [], selectedId: "root", swarmCount: 3, pendingReplies: 0 };
}
function controls(state: TelegramUiState) {
  return renderTelegramKeyboard(state).inline_keyboard.flat().map((button) => button.callback_data);
}

describe("Telegram compact button dashboard", () => {
  it("has buttons to reach every major workflow and valid Telegram callbacks", () => {
    const home = controls(state("home"));
    for (const panel of ["sessions", "actions", "models", "effort", "swarm", "tools", "updates", "settings"]) {
      expect(home).toContain("nav:" + panel);
    }
    const panels: TelegramPanel[] = ["home", "sessions", "folders", "actions", "models", "effort", "swarm", "jobs", "updates", "tools", "settings"];
    for (const panel of panels) {
      expect(panelTitle(panel).length).toBeGreaterThan(0);
      const keyboard = renderTelegramKeyboard(state(panel));
      expect(keyboard.inline_keyboard.length).toBeGreaterThan(0);
      for (const row of keyboard.inline_keyboard) {
        expect(row.length).toBeGreaterThan(0);
        for (const button of row) expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
      }
    }
  });

  it("paginates sessions and folders without dropping options", () => {
    const sessions = state("sessions");
    sessions.sessionMenu = Array.from({ length: 13 }, (_, index) => ({
      id: "s" + index, title: "Session " + index, workspace: "/projects/p" + index, updatedAt: index,
    }));
    sessions.sessionPage = 2;
    expect(controls(sessions)).toContain("ss:s12");
    expect(controls(sessions)).not.toContain("ss:s0");
    const folders = state("folders");
    folders.folderMenu = Array.from({ length: 21 }, (_, index) => "/projects/p" + index);
    folders.folderPage = 3;
    expect(controls(folders)).toContain("fo:15");
    expect(controls(folders)).not.toContain("fo:0");
  });

  it("replaces regular buttons with confirmation or input cancellation", () => {
    const confirmation = state("updates");
    confirmation.confirmation = "/update apply";
    expect(controls(confirmation)).toEqual(["confirm:yes", "confirm:no"]);
    const input = state("actions");
    input.awaiting = "goal";
    expect(controls(input)).toEqual(["input:cancel"]);
  });

  it("shows real model options and never embeds long labels in callback payloads", () => {
    const model = state("models");
    model.modelOptions = ["Very long model label".repeat(10), "GPT-6"];
    expect(controls(model)).toContain("pick:model:1");
    expect(controls(model)).not.toContain("pick:model:GPT-6");
  });
});
