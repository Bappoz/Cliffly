using System.Diagnostics;

namespace Cliffly.Sessions;

public class FrameExtractor
{
    public async Task<bool> IsValidVideoAsync(string videoPath)
    {
        var (exitCode, _) = await RunProcessAsync("ffprobe", $"-v error \"{videoPath}\"");
        return exitCode == 0;
    }

    public async Task<int> ExtractFramesAsync(string videoPath, string framesDir, int intervalSeconds)
    {
        Directory.CreateDirectory(framesDir);
        
        var outputPattern = Path.Combine(framesDir, "%03d.jpg");
        var args = $"-i \"{videoPath}\" -vf fps=1/{intervalSeconds} \"{outputPattern}\"";
        var (exitCode, stdErr) = await RunProcessAsync("ffmpeg", args);

        if (exitCode != 0)
        {
            throw new InvalidOperationException($"ffmpeg exited with code {exitCode}: {stdErr}");
        }
        
        return Directory.GetFiles(framesDir, "*.jpg").Length;
    }

    private static async Task<(int ExitCode, string StdErr)> RunProcessAsync(string fileName, string arguments)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = fileName,
                Arguments = arguments,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            }
        };

        process.Start();
        
        var stdErrTask = process.StandardError.ReadToEndAsync();
        var stdOutTask = process.StandardOutput.ReadToEndAsync();
        
        await process.WaitForExitAsync();
        var stdErr = await stdErrTask;
        await stdOutTask;
        
        return (process.ExitCode, stdErr);
    }
}