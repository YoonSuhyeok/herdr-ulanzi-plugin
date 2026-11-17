Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class Win32Focus {
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);
}
"@

$proc = Get-Process -Name 'herdr-app', 'herdr' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
    Select-Object -First 1

if ($null -eq $proc) {
    Start-Process 'herdr-app'
    exit 0
}

$hwnd = $proc.MainWindowHandle
if ([Win32Focus]::IsIconic($hwnd)) {
    [void][Win32Focus]::ShowWindow($hwnd, 9) # SW_RESTORE
}

$fgHwnd = [Win32Focus]::GetForegroundWindow()
$dummy = [uint32]0
$fgThread = [Win32Focus]::GetWindowThreadProcessId($fgHwnd, [ref]$dummy)
$curThread = [Win32Focus]::GetCurrentThreadId()

if ($fgThread -ne $curThread -and $fgThread -ne 0) {
    [void][Win32Focus]::AttachThreadInput($curThread, $fgThread, $true)
    [void][Win32Focus]::BringWindowToTop($hwnd)
    [void][Win32Focus]::SetForegroundWindow($hwnd)
    [void][Win32Focus]::AttachThreadInput($curThread, $fgThread, $false)
} else {
    [void][Win32Focus]::BringWindowToTop($hwnd)
    [void][Win32Focus]::SetForegroundWindow($hwnd)
}
