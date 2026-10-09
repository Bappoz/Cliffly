using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;

namespace Cliffly.Sessions;

public record GuidedScanState(Guid ScanId, string Status, DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt, JsonElement? Preview = null, string? Error = null);

public sealed class GuidedScanManager : BackgroundService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly ConcurrentDictionary<Guid, Runtime> active = new();
    private readonly SemaphoreSlim creation = new(1);
    private readonly string root;
    private readonly string python;
    private readonly string script;
    private readonly TimeSpan idle;
    private readonly ILogger<GuidedScanManager> logger;
    public bool IsAvailable => File.Exists(script) && (File.Exists(python) || !python.Contains(Path.DirectorySeparatorChar));
    public string GetDirectory(Guid id) => Path.Combine(root, id.ToString());

    public GuidedScanManager(CaptureSessionStore store, IConfiguration config, IWebHostEnvironment environment,
        ILogger<GuidedScanManager> logger)
    {
        this.logger = logger;
        root = Path.Combine(store.Root, "scans");
        var project = Directory.Exists(Path.Combine(environment.ContentRootPath, "reconstruction"))
            ? environment.ContentRootPath : Path.GetFullPath(Path.Combine(environment.ContentRootPath, ".."));
        python = config["Reconstruction:Python"] ?? Path.Combine(project, ".venv", OperatingSystem.IsWindows() ? "Scripts/python.exe" : "bin/python");
        script = config["Reconstruction:GuideScript"] ?? Path.Combine(project, "reconstruction", "guide.py");
        idle = TimeSpan.FromSeconds(Math.Clamp(config.GetValue("GuidedScan:IdleSeconds", 30), 2, 120));
    }

    public async Task<GuidedScanState?> CreateAsync(CancellationToken cancellationToken)
    {
        if (!IsAvailable) throw new InvalidOperationException("Motor da prévia não instalado. A gravação pode continuar sem prévia.");
        await creation.WaitAsync(cancellationToken);
        try
        {
            if (!active.IsEmpty) return null;
            var id = Guid.NewGuid(); var directory = GetDirectory(id); Directory.CreateDirectory(directory);
            var runtime = new Runtime(id, directory, python, script);
            try
            {
                await runtime.SaveAsync();
                active[id] = runtime;
                return runtime.State;
            }
            catch { await runtime.StopAsync("failed", "Falha ao iniciar a prévia."); throw; }
        }
        finally { creation.Release(); }
    }

    public async Task<GuidedScanState?> GetAsync(Guid id, CancellationToken cancellationToken)
    {
        if (active.TryGetValue(id, out var runtime)) return runtime.State;
        var path = Path.Combine(GetDirectory(id), "scan.json");
        try
        {
            await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            return await JsonSerializer.DeserializeAsync<GuidedScanState>(stream, JsonOptions, cancellationToken);
        }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
    }

    public async Task<GuidedScanState> ProcessAsync(Guid id, byte[] jpeg, CancellationToken cancellationToken)
    {
        if (!active.TryGetValue(id, out var runtime)) throw new KeyNotFoundException("Esta prévia não está ativa.");
        try { return await runtime.FrameAsync(jpeg, cancellationToken); }
        catch (InvalidDataException) { throw; }
        catch (ScanBusyException) { throw; }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Falha na prévia {ScanId}", id);
            await StopScanAsync(id, "failed", "A prévia foi interrompida. A gravação pode continuar e ser analisada ao terminar.");
            throw new InvalidOperationException("A prévia foi interrompida. Continue gravando e refine ao terminar.");
        }
    }

    public Task StopScanAsync(Guid id, string status = "stopped", string? error = null) =>
        active.TryRemove(id, out var runtime) ? runtime.StopAsync(status, error) : Task.CompletedTask;

    public override async Task StartAsync(CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(root);
        foreach (var directory in Directory.EnumerateDirectories(root))
        {
            if (!Guid.TryParse(Path.GetFileName(directory), out var id)) continue;
            var state = await GetAsync(id, cancellationToken);
            if (state?.Status == "active") await WriteStateAsync(directory, state with { Status = "interrupted",
                Error = "Prévia interrompida pelo reinício do servidor.", UpdatedAt = DateTimeOffset.UtcNow });
        }
        await base.StartAsync(cancellationToken);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
            while (await timer.WaitForNextTickAsync(stoppingToken))
                foreach (var entry in active)
                    if (DateTimeOffset.UtcNow - entry.Value.State.UpdatedAt > idle ||
                        DateTimeOffset.UtcNow - entry.Value.State.CreatedAt > TimeSpan.FromMinutes(3))
                        await StopScanAsync(entry.Key, "expired", "Prévia encerrada por inatividade ou limite de duração.");
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        finally { foreach (var id in active.Keys) await StopScanAsync(id, "interrupted", "Servidor encerrado."); }
    }

    private static async Task WriteStateAsync(string directory, GuidedScanState state)
    {
        var temporary = Path.Combine(directory, $"scan-{Guid.NewGuid()}.tmp");
        try
        {
            await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(state, JsonOptions));
            File.Move(temporary, Path.Combine(directory, "scan.json"), true);
        }
        finally { File.Delete(temporary); }
    }

    public sealed class ScanBusyException : Exception;

    private sealed class Runtime
    {
        private readonly Process process;
        private readonly SemaphoreSlim gate = new(1);
        private readonly string directory;
        private readonly Task errors;
        private int frames;
        private volatile bool stopped;
        public GuidedScanState State { get; private set; }

        public Runtime(Guid id, string directory, string python, string script)
        {
            this.directory = directory;
            var now = DateTimeOffset.UtcNow;
            State = new(id, "active", now, now);
            process = new Process { StartInfo = new ProcessStartInfo(python)
                { RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false } };
            foreach (var value in new[] { "-u", script, "--output", directory }) process.StartInfo.ArgumentList.Add(value);
            process.StartInfo.Environment["OMP_NUM_THREADS"] = "2";
            process.StartInfo.Environment["OPENCV_IO_MAX_IMAGE_PIXELS"] = "1048576";
            process.Start();
            errors = DrainAsync(process.StandardError);
        }

        public Task SaveAsync() => WriteStateAsync(directory, State);

        public async Task<GuidedScanState> FrameAsync(byte[] jpeg, CancellationToken cancellationToken)
        {
            if (!await gate.WaitAsync(0, cancellationToken)) throw new ScanBusyException();
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(15));
            var path = Path.Combine(directory, "input.jpg");
            try
            {
                if (stopped || ++frames > 180) throw new InvalidOperationException("Prévia encerrada ou limite de frames atingido.");
                await File.WriteAllBytesAsync(path, jpeg, timeout.Token);
                await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new { frame = path }).AsMemory(), timeout.Token);
                await process.StandardInput.FlushAsync(timeout.Token);
                var line = await process.StandardOutput.ReadLineAsync(timeout.Token);
                if (line is null) throw new InvalidOperationException("O processo da prévia terminou.");
                using var json = JsonDocument.Parse(line);
                if (json.RootElement.TryGetProperty("error", out var error))
                    throw new InvalidDataException(error.GetString());
                if (!stopped)
                {
                    State = State with { Preview = json.RootElement.Clone(), UpdatedAt = DateTimeOffset.UtcNow };
                    await SaveAsync();
                }
                return State;
            }
            finally { try { File.Delete(path); } finally { gate.Release(); } }
        }

        public async Task StopAsync(string status, string? error)
        {
            stopped = true;
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
            await errors;
            // Wait for the outstanding frame reader before disposing its streams.
            await gate.WaitAsync();
            try
            {
                State = State with { Status = status, Error = error, UpdatedAt = DateTimeOffset.UtcNow };
                await SaveAsync(); process.Dispose();
            }
            finally { gate.Release(); }
        }

        private static async Task DrainAsync(StreamReader reader)
        {
            var buffer = new char[4096];
            while (await reader.ReadAsync(buffer) > 0) { }
        }
    }
}
