export const selectors = {
  composer: [
    "#prompt-textarea",
    'div[contenteditable="true"][data-lexical-editor="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    'textarea[data-id="root"]',
  ],
  sendButton: [
    '[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="Отправить" i]',
    'button[data-testid="composer-send-button"]',
  ],
  stopButton: [
    '[data-testid="stop-button"]',
    '[data-testid="stop-generating"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="Stop" i]',
    'button[aria-label^="Stop generating" i]',
    'button[aria-label^="Stop streaming" i]',
    'button[aria-label^="Stop responding" i]',
    'button[aria-label^="Stop response" i]',
    'button[aria-label="Остановить" i]',
    'button[aria-label^="Остановить генерацию" i]',
    'button[aria-label^="Остановить ответ" i]',
    'button[title*="stop generating" i]',
    'button[title*="Остановить" i]',
  ],
  assistantMessage: [
    '[data-message-author-role="assistant"]',
    '[data-message-author="assistant"]',
  ],
  userMessage: ['[data-message-author-role="user"]'],
  markdown: [".markdown", '[class*="markdown"]'],
  loginButton: [
    '[data-testid="login-button"]',
    'button:has-text("Log in")',
    'button:has-text("Войти")',
  ],
  modelButton: [
    '[data-testid="model-switcher-dropdown-button"]',
    'button[aria-label*="model" i]',
    'button[aria-haspopup="menu"]',
  ],
  modelMenuItem: ['[role="menuitem"]', '[role="option"]', '[data-testid*="model"]'],
  temporaryChat: [
    'text=Temporary chat',
    'text=Временный чат',
    '[data-testid="temporary-chat-banner"]',
  ],
  allowButton: [
    '[role="dialog"] button:has-text("Allow once")',
    '[role="dialog"] button:has-text("Always allow")',
    '[role="dialog"] button:has-text("Allow")',
    '[role="dialog"] button:has-text("Разрешить")',
    'button:has-text("Allow once")',
  ],
  connectorMenuRow: [
    '.__menu-item[tabindex="0"]',
    '[data-mention-list-scroll-area] button[data-list-navigation-item="true"]',
    '[role="option"][data-keyword]',
  ],
  connectorDialog: [
    '[role="dialog"]',
    '[role="menu"]',
    '[role="listbox"]',
  ],
  newChat: [
    'a[data-testid="create-new-chat-button"]',
    'button[data-testid="create-new-chat-button"]',
    'a[href="/"]',
  ],
} as const;

export type SelectorGroup = keyof typeof selectors;
