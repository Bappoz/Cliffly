using System.Text.Json;
using System.Collections.Concurrent;

namespace Cliffly.Sessions;

public sealed class CaptureSessionStore(string captureRoot)
{
    private readonly ConcurrentDictionary<Guid, byte> uploads = new();
    public bool TryBeginUpload(Guid id) => uploads.TryAdd(id, 0);
    public void FinishUpload(Guid id) => uploads.TryRemove(id, out _);

    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };
    public string Root { get; } = Path.GetFullPath(captureRoot);
    public string GetSessionDirectory(Guid sessionId) => Path.Combine(Root, sessionId.ToString());

    public async Task<CaptureSession> CreateAsync(CancellationToken cancellationToken = default)
    {
        var session = new CaptureSession
        {
            SessionId = Guid.NewGuid(),
            CreatedAt = DateTimeOffset.UtcNow,
            Status = "pending",
            FrameIntervalSeconds = 1
        };
        Directory.CreateDirectory(GetSessionDirectory(session.SessionId));
        await SaveAsync(session, cancellationToken);
        return session;
    }

    public async Task<CaptureSession?> TryGetAsync(Guid sessionId, CancellationToken cancellationToken = default)
    {
        var path = Path.Combine(GetSessionDirectory(sessionId), "manifest.json");
        try
        {
            await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete, 4096, FileOptions.Asynchronous);
            return await JsonSerializer.DeserializeAsync<CaptureSession>(stream, cancellationToken: cancellationToken);
        }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
    }

    public async Task SaveAsync(CaptureSession session, CancellationToken cancellationToken = default)
    {
        var directory = GetSessionDirectory(session.SessionId);
        var path = Path.Combine(directory, "manifest.json");
        var temporary = Path.Combine(directory, $"manifest-{Guid.NewGuid()}.tmp");
        try
        {
            await using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write,
                FileShare.None, 4096, FileOptions.Asynchronous))
            {
                await JsonSerializer.SerializeAsync(stream, session, JsonOptions, cancellationToken);
                await stream.FlushAsync(cancellationToken);
            }
            File.Move(temporary, path, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    public async Task RecoverInterruptedAsync(CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Root);
        foreach (var directory in Directory.EnumerateDirectories(Root))
        {
            if (!Guid.TryParse(Path.GetFileName(directory), out var id)) continue;
            var session = await TryGetAsync(id, cancellationToken);
            if (session?.Status == "processing")
                await SaveAsync(session with { Status = "error", Error = "Processamento interrompido. Crie uma nova sessão para reenviar." }, cancellationToken);
            else if (session?.ReconstructionStatus is "queued" or "processing")
                await SaveAsync(session with { ReconstructionStatus = "failed", ReconstructionStage = "interrupted",
                    ReconstructionMessage = "Reconstrução interrompida pelo reinício. Você pode tentar novamente." }, cancellationToken);
        }
    }
}
