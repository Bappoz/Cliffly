using System.Diagnostics;

namespace Cliffly.Sessions;

public sealed class FrameExtractor
{
    public async Task<bool> IsValidVideoAsync(string videoPath, CancellationToken cancellationToken = default)
    {
        var (code, output, _) = await RunProcessAsync("ffprobe",
            ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", videoPath],
            TimeSpan.FromSeconds(20), cancellationToken);
        return code == 0 && !string.IsNullOrWhiteSpace(output);
    }

    public async Task<int> ExtractFramesAsync(string videoPath, string framesDir, int intervalSeconds,
        CancellationToken cancellationToken = default)
    {
        if (intervalSeconds <= 0) throw new ArgumentOutOfRangeException(nameof(intervalSeconds));
        Directory.CreateDirectory(framesDir);
        var (code, _, error) = await RunProcessAsync("ffmpeg",
            ["-nostdin", "-v", "error", "-y", "-i", videoPath, "-t", "120", "-vf", $"fps=1/{intervalSeconds},scale=1280:720:force_original_aspect_ratio=decrease", Path.Combine(framesDir, "%04d.jpg")],
            TimeSpan.FromMinutes(2), cancellationToken);
        if (code != 0) throw new InvalidOperationException($"FFmpeg falhou ({code}): {error[..Math.Min(error.Length, 1000)]}");
        var count = Directory.GetFiles(framesDir, "*.jpg").Length;
        if (count == 0) throw new InvalidOperationException("O vídeo não produziu frames. Grave ao menos um segundo.");
        return count;
    }

    private static async Task<(int Code, string Output, string Error)> RunProcessAsync(string name,
        string[] arguments, TimeSpan timeout, CancellationToken cancellationToken)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(timeout);
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo(name) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false }
        };
        foreach (var argument in arguments) process.StartInfo.ArgumentList.Add(argument);
        try { process.Start(); }
        catch (System.ComponentModel.Win32Exception ex)
        { throw new InvalidOperationException($"Instale FFmpeg (ffmpeg e ffprobe no PATH). Não foi possível iniciar {name}.", ex); }
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        try { await process.WaitForExitAsync(deadline.Token); }
        catch (OperationCanceledException)
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync(CancellationToken.None);
            await Task.WhenAll(output, error);
            cancellationToken.ThrowIfCancellationRequested();
            throw new TimeoutException($"{name} excedeu o limite de {timeout.TotalSeconds:0} segundos.");
        }
        return (process.ExitCode, await output, await error);
    }
}
