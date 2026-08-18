const { execSync } = require("child_process");

/**
 * Disables Windows Console QuickEdit Mode.
 *
 * Why this is essential:
 * In Windows Console (conhost.exe), clicking or unfocusing the terminal puts the console in
 * "Select / Mark" mode (QuickEdit), which freezes the entire Node.js event loop and stops
 * all incoming/outgoing socket connections until the user presses Enter.
 */
function disableWindowsQuickEdit() {
  if (process.platform !== "win32") return;

  // 1. Ensure stdin is paused and unreferenced so it never blocks the event loop
  try {
    if (process.stdin && typeof process.stdin.pause === "function") {
      process.stdin.pause();
    }
    if (process.stdin && typeof process.stdin.unref === "function") {
      process.stdin.unref();
    }
  } catch {
    // Ignore
  }

  // 2. Disable QuickEdit mode on the active console handle via Win32 API
  try {
    const psCommand = `
      $def = @'
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr GetStdHandle(int nStdHandle);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);
'@
      $win32 = Add-Type -MemberDefinition $def -Name "NativeConsole" -Namespace "Win32" -PassThru
      $hStdin = $win32::GetStdHandle(-10)
      $mode = 0
      if ($win32::GetConsoleMode($hStdin, [ref]$mode)) {
        $ENABLE_QUICK_EDIT_MODE = 0x0040
        $ENABLE_EXTENDED_FLAGS = 0x0080
        $newMode = ($mode -band (-bnot $ENABLE_QUICK_EDIT_MODE)) -bor $ENABLE_EXTENDED_FLAGS
        $win32::SetConsoleMode($hStdin, $newMode) | Out-Null
      }
    `;

    execSync(`powershell -NoProfile -NonInteractive -Command "${psCommand.replace(/\r?\n\s*/g, ' ')}"`, {
      stdio: "ignore",
      windowsHide: true,
      timeout: 3000
    });
  } catch {
    // Non-fatal if running in headless/CI environment
  }
}

module.exports = {
  disableWindowsQuickEdit
};
