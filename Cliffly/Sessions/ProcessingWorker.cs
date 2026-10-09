using System.Threading.Channels;

namespace Cliffly.Sessions;

public sealed class ProcessingWorker(CaptureSessionStore store, FrameExtractor extractor,
    ILogger<ProcessingWorker> logger) : BackgroundService
{
    private readonly Channel<CaptureSession> queue = Channel.CreateBounded<CaptureSession>(new BoundedChannelOptions(8)
    { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });

    public bool TryEnqueue(CaptureSession session) => queue.Writer.TryWrite(session);

    public override async Task StartAsync(CancellationToken cancellationToken)
    {
        await store.RecoverInterruptedAsync(cancellationToken);
        await base.StartAsync(cancellationToken);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await foreach (var session in queue.Reader.ReadAllAsync(stoppingToken))
            {
                try
                {
                    var directory = store.GetSessionDirectory(session.SessionId);
                    var video = Path.Combine(directory, "video.mp4");
                    if (!await extractor.IsValidVideoAsync(video, stoppingToken))
                        throw new InvalidOperationException("Arquivo inválido ou sem stream de vídeo decodificável.");
                    var count = await extractor.ExtractFramesAsync(video, Path.Combine(directory, "frames"), session.FrameIntervalSeconds, stoppingToken);
                    await store.SaveAsync(session with { Status = "done", FrameCount = count, Error = null }, stoppingToken);
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Falha ao processar sessão {SessionId}", session.SessionId);
                    await store.SaveAsync(session with { Status = "error", Error = ex is OperationCanceledException ? "Processamento interrompido pelo encerramento do servidor." : ex.Message });
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
}
