using System;
using System.Diagnostics;
using System.IO;

internal static class Program
{
    private static int Main()
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string script = Path.Combine(baseDir, "install.ps1");
        string escapedScript = script.Replace("\"", "\\\"");
        string systemRoot = Environment.GetEnvironmentVariable("SystemRoot") ?? "C:\\Windows";
        string powershell = Path.Combine(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

        var startInfo = new ProcessStartInfo
        {
            FileName = powershell,
            Arguments = string.Format("-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"{0}\"", escapedScript),
            WorkingDirectory = baseDir,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        using (Process process = Process.Start(startInfo))
        {
            process.WaitForExit();
            return process.ExitCode;
        }
    }
}
