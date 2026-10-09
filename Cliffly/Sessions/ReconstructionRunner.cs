using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Cliffly.Sessions;

public record ReconstructionProgress(string Stage, int Percent, string Message);

public interface IReconstructionRunner
{
    bool IsAvailable { get; }
    Task RunAsync(string directory, Func<ReconstructionProgress, Task> onProgress, CancellationToken cancellationToken);
}

public sealed class ReconstructionRunner : IReconstructionRunner
{
    private readonly string python;
    private readonly string script;
    public ReconstructionRunner(IConfiguration config, IWebHostEnvironment environment)
    {
        var root = Directory.Exists(Path.Combine(environment.ContentRootPath, "reconstruction"))
            ? environment.ContentRootPath : Path.GetFullPath(Path.Combine(environment.ContentRootPath, ".."));
        script = config["Reconstruction:Script"] ?? Path.Combine(root, "reconstruction", "reconstruct.py");
        python = config["Reconstruction:Python"] ?? Path.Combine(root, ".venv",
            OperatingSystem.IsWindows() ? "Scripts/python.exe" : "bin/python");
    }
    public bool IsAvailable => File.Exists(script) && (File.Exists(python) || !python.Contains(Path.DirectorySeparatorChar));

    public async Task RunAsync(string directory, Func<ReconstructionProgress, Task> onProgress, CancellationToken cancellationToken)
    {
        if (!IsAvailable) throw new InvalidOperationException("Motor não instalado. Execute o setup Python descrito no README.");
        var output = Path.Combine(directory, "reconstruction");
        Directory.CreateDirectory(output);
        File.Delete(Path.Combine(output, "world.json"));
        File.Delete(Path.Combine(output, "progress.json"));
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromMinutes(20));
        using var process = new Process { StartInfo = new ProcessStartInfo(python)
            { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false } };
        foreach (var arg in new[] { "-u", script, "--frames", Path.Combine(directory, "frames"), "--output", output })
            process.StartInfo.ArgumentList.Add(arg);
        process.StartInfo.Environment["OMP_NUM_THREADS"] = "4";
        process.Start();
        var errors = DrainErrorsAsync(process.StandardError);
        try
        {
            while (await process.StandardOutput.ReadLineAsync(timeout.Token) is { } line)
            {
                try
                {
                    using var json = JsonDocument.Parse(line);
                    var value = json.RootElement;
                    await onProgress(new(value.GetProperty("stage").GetString()!,
                        value.GetProperty("percent").GetInt32(), value.GetProperty("message").GetString()!));
                }
                catch (JsonException) { /* Native dependency logs are not progress events. */ }
            }
            await process.WaitForExitAsync(timeout.Token);
            var tail = await errors;
            await File.WriteAllTextAsync(Path.Combine(output, "diagnostics.log"), tail, CancellationToken.None);
            if (process.ExitCode != 0)
            {
                var progressFile = Path.Combine(output, "progress.json");
                var message = "Não foi possível reconstruir o ambiente. Confira a captura e tente novamente.";
                if (File.Exists(progressFile))
                {
                    using var json = JsonDocument.Parse(await File.ReadAllTextAsync(progressFile, cancellationToken));
                    message = json.RootElement.GetProperty("message").GetString() ?? message;
                }
                throw new InvalidOperationException(message);
            }
            using var world = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(output, "world.json"), cancellationToken));
            if (world.RootElement.GetProperty("version").GetInt32() != 2 || world.RootElement.GetProperty("points").GetArrayLength() < 7)
                throw new InvalidOperationException("O motor não gerou um mundo válido.");
        }
        catch (OperationCanceledException)
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync(CancellationToken.None);
            await errors;
            throw new InvalidOperationException(cancellationToken.IsCancellationRequested
                ? "Reconstrução interrompida. Você pode tentar novamente."
                : "Reconstrução excedeu 20 minutos. Tente um vídeo menor e mais nítido.");
        }
        catch
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync(CancellationToken.None);
            await errors;
            throw;
        }
    }

    private static async Task<string> DrainErrorsAsync(StreamReader reader)
    {
        var tail = new StringBuilder();
        var buffer = new char[4096];
        int count;
        while ((count = await reader.ReadAsync(buffer)) > 0)
        {
            tail.Append(buffer, 0, count);
            if (tail.Length > 16000) tail.Remove(0, tail.Length - 16000);
        }
        return tail.ToString();
    }
}
