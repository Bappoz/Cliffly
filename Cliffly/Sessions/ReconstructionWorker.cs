using System.Collections.Concurrent;
using System.Threading.Channels;

namespace Cliffly.Sessions;

public sealed class ReconstructionWorker(CaptureSessionStore store, IReconstructionRunner runner,
    ILogger<ReconstructionWorker> logger) : BackgroundService
{
    private readonly Channel<CaptureSession> queue = Channel.CreateBounded<CaptureSession>(new BoundedChannelOptions(2)
        { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });
    private readonly ConcurrentDictionary<Guid, byte> active = new();

    public async Task<string> ScheduleAsync(Guid id, CancellationToken cancellationToken)
    {
        if (!runner.IsAvailable) return "unavailable";
        if (!active.TryAdd(id, 0)) return "conflict";
        var scheduled = false;
        try
        {
            var session = await store.TryGetAsync(id, cancellationToken);
            if (session is null) return "missing";
            if (session.Status != "done" || session.FrameCount < 3) return "notready";
            if (session.ReconstructionStatus == "complete") return "conflict";
            var pending = session with { ReconstructionStatus = "queued", ReconstructionStage = "queued",
                ReconstructionPercent = 0, ReconstructionMessage = "Na fila de reconstrução…" };
            await store.SaveAsync(pending, cancellationToken);
            if (!queue.Writer.TryWrite(pending))
            {
                await store.SaveAsync(session, CancellationToken.None);
                return "full";
            }
            scheduled = true;
            return "queued";
        }
        finally { if (!scheduled) active.TryRemove(id, out _); }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await foreach (var queued in queue.Reader.ReadAllAsync(stoppingToken))
            {
                var session = queued with { ReconstructionStatus = "processing" };
                try
                {
                    await store.SaveAsync(session, stoppingToken);
                    await runner.RunAsync(store.GetSessionDirectory(session.SessionId), async progress =>
                    {
                        session = session with { ReconstructionStage = progress.Stage,
                            ReconstructionPercent = Math.Clamp(progress.Percent, 0, 100), ReconstructionMessage = progress.Message };
                        await store.SaveAsync(session, stoppingToken);
                    }, stoppingToken);
                    session = session with { ReconstructionStatus = "complete", ReconstructionStage = "complete",
                        ReconstructionPercent = 100, ReconstructionMessage = "Mundo 3D salvo. Pronto para explorar." };
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Falha na reconstrução {SessionId}", session.SessionId);
                    session = session with { ReconstructionStatus = "failed", ReconstructionMessage = ex.Message };
                }
                finally
                {
                    await store.SaveAsync(session, CancellationToken.None);
                    active.TryRemove(session.SessionId, out _);
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
}
