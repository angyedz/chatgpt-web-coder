// Restore native terminal selection even if a previous app left mouse reporting enabled.
export const disableMouse = "\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1005l\u001b[?1006l\u001b[?1015l";
