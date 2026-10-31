using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

internal static class Launcher
{
    // Follow the Windows command-line quoting rules used by the Node runtime.
    private static string Quote(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '\r', '\n', '\v', '"' }) < 0) return argument;
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"')
            {
                result.Append('\\', slashes * 2 + 1);
                result.Append('"');
            }
            else
            {
                result.Append('\\', slashes);
                result.Append(character);
            }
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static int Main(string[] args)
    {
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string release = File.ReadAllText(Path.Combine(root, "current.txt")).Trim();
            if (!Regex.IsMatch(release, "^[0-9a-f]{32}$")) throw new Exception("Invalid installed release marker.");
            string releaseDir = Path.Combine(root, "releases", release);
            string runtime = Path.Combine(releaseDir, "runtime");
            string node = Path.Combine(runtime, "node.exe");
            string script = Path.Combine(releaseDir, "app", "dist", "index.js");
            if (!File.Exists(node) || !File.Exists(script)) throw new Exception("The installation is incomplete. Run the installer again.");
            var command = new StringBuilder(Quote(script));
            foreach (string argument in args) command.Append(' ').Append(Quote(argument));
            var start = new ProcessStartInfo(node, command.ToString());
            start.UseShellExecute = false;
            start.WorkingDirectory = Directory.GetCurrentDirectory();
            start.EnvironmentVariables["PLAYWRIGHT_BROWSERS_PATH"] = Path.Combine(root, "browsers");
            start.EnvironmentVariables["CHATGPT_CODER_INSTALL_DIR"] = root;
            start.EnvironmentVariables["CHATGPT_CODER_RELEASE_ID"] = release;
            start.EnvironmentVariables["PATH"] = runtime + ";" + (Environment.GetEnvironmentVariable("PATH") ?? "") + ";" + Path.Combine(releaseDir, "git", "cmd");
            using (Process process = Process.Start(start))
            {
                if (process == null) throw new Exception("Could not start Node.js.");
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("chatgpt-coder: " + error.Message);
            return 1;
        }
    }
}
