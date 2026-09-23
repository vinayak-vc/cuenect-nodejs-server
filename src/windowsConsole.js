/**
 * Windows Console configuration.
 * Preserves QuickEdit mode and mouse selection so users can freely select,
 * highlight, and copy text, URLs, and errors directly from the terminal.
 */
function enableWindowsConsoleSelection() {
  // Allow standard Windows console mouse text selection and copying.
}

module.exports = {
  disableWindowsQuickEdit: enableWindowsConsoleSelection,
  enableWindowsConsoleSelection
};
