using Cliffly.Sessions;
using Microsoft.AspNetCore.Http.Features;

var builder = WebApplication.CreateBuilder(args);
const long uploadLimit = 128 * 1024 * 1024;
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = uploadLimit + 65536);
builder.Services.Configure<FormOptions>(options => options.MultipartBodyLengthLimit = uploadLimit);
builder.Services.AddSingleton(new CaptureSessionStore(builder.Configuration["CaptureRoot"]
    ?? Path.Combine(builder.Environment.ContentRootPath, "captures")));
builder.Services.AddSingleton<FrameExtractor>();
builder.Services.AddSingleton<ProcessingWorker>();
builder.Services.AddHostedService(provider => provider.GetRequiredService<ProcessingWorker>());
builder.Services.AddSingleton<IReconstructionRunner, ReconstructionRunner>();
builder.Services.AddSingleton<ReconstructionWorker>();
builder.Services.AddHostedService(provider => provider.GetRequiredService<ReconstructionWorker>());
var app = builder.Build();
if (string.IsNullOrEmpty(builder.Configuration["urls"])) app.Urls.Add("http://localhost:5000");
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapGet("/health", (IReconstructionRunner runner) => Results.Ok(new { status = "ok", reconstructionAvailable = runner.IsAvailable }));
app.MapPost("/sessions", async (CaptureSessionStore store, CancellationToken cancellationToken) =>
{
    var session = await store.CreateAsync(cancellationToken);
    return Results.Created($"/sessions/{session.SessionId}", session);
});
app.MapPost("/sessions/{sessionId:guid}/video", async (Guid sessionId, IFormFile video,
    CaptureSessionStore store, ProcessingWorker worker, CancellationToken cancellationToken) =>
{
    var session = await store.TryGetAsync(sessionId, cancellationToken);
    if (session is null) return Results.NotFound();
    if (video.Length == 0 || video.Length > uploadLimit)
        return Results.BadRequest(new { error = "Envie um vídeo entre 1 byte e 128 MiB." });
    var directory = store.GetSessionDirectory(sessionId);
    var destination = Path.Combine(directory, "video.mp4");
    var temporary = Path.Combine(directory, "video.upload");
    if (!store.TryBeginUpload(sessionId))
        return Results.Conflict(new { error = "Já existe um upload em andamento." });
    var ownsVideo = false;
    var enqueued = false;
    try
    {
        if (File.Exists(destination)) return Results.Conflict(new { error = "Essa sessão já tem um vídeo." });
        await using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None, 81920, FileOptions.Asynchronous))
        {
            await video.CopyToAsync(stream, cancellationToken);
        }
        File.Move(temporary, destination);
        ownsVideo = true;
        var extension = Path.GetExtension(video.FileName).ToLowerInvariant();
        if (extension is not (".webm" or ".mp4" or ".mov" or ".mkv")) extension = ".video";
        var processing = session with { Status = "processing", Error = null, VideoExtension = extension };
        await store.SaveAsync(processing, cancellationToken);
        if (!worker.TryEnqueue(processing))
        {
            File.Delete(destination);
            await store.SaveAsync(session, CancellationToken.None);
            return Results.Json(new { error = "Fila cheia. Tente novamente em alguns segundos." }, statusCode: 503);
        }
        enqueued = true;
        return Results.Accepted($"/sessions/{sessionId}", processing);
    }
    catch
    {
        if (ownsVideo && !enqueued)
        {
            if (File.Exists(destination)) File.Delete(destination);
            await store.SaveAsync(session, CancellationToken.None);
        }
        throw;
    }
    finally
    {
        try { if (File.Exists(temporary)) File.Delete(temporary); }
        finally { store.FinishUpload(sessionId); }
    }
}).DisableAntiforgery();
app.MapGet("/sessions/{sessionId:guid}", async (Guid sessionId, CaptureSessionStore store, CancellationToken cancellationToken) =>
{
    var session = await store.TryGetAsync(sessionId, cancellationToken);
    return session is null ? Results.NotFound() : Results.Ok(session);
});
app.MapPost("/sessions/{sessionId:guid}/reconstruction", async (Guid sessionId, ReconstructionWorker worker, CancellationToken cancellationToken) =>
{
    var result = await worker.ScheduleAsync(sessionId, cancellationToken);
    return result switch
    {
        "queued" => Results.Accepted($"/sessions/{sessionId}", new { status = result }),
        "missing" => Results.NotFound(),
        "notready" => Results.BadRequest(new { error = "Aguarde os frames. São necessários ao menos três frames." }),
        "conflict" => Results.Conflict(new { error = "Esta sessão já está sendo reconstruída ou tem um mundo pronto." }),
        "unavailable" => Results.Json(new { error = "Instale o motor Python seguindo o README e reinicie o servidor." }, statusCode: 503),
        _ => Results.Json(new { error = "Fila cheia. Tente novamente em alguns segundos." }, statusCode: 503)
    };
});
app.MapGet("/sessions/{sessionId:guid}/world", async (Guid sessionId, CaptureSessionStore store, CancellationToken cancellationToken) =>
{
    var session = await store.TryGetAsync(sessionId, cancellationToken);
    if (session is null) return Results.NotFound();
    var path = Path.Combine(store.GetSessionDirectory(sessionId), "reconstruction", "world.json");
    return session.ReconstructionStatus == "complete" && File.Exists(path)
        ? Results.File(path, "application/json", $"cliffly-{sessionId}.json")
        : Results.Conflict(new { error = "O mundo ainda não está pronto." });
});
app.MapGet("/sessions/{sessionId:guid}/video", async (Guid sessionId, CaptureSessionStore store, CancellationToken cancellationToken) =>
{
    var session = await store.TryGetAsync(sessionId, cancellationToken);
    var path = Path.Combine(store.GetSessionDirectory(sessionId), "video.mp4");
    return session is not null && session.Status == "done" && File.Exists(path)
        ? Results.File(path, "application/octet-stream", $"cliffly-{sessionId}{session.VideoExtension}", enableRangeProcessing: true)
        : Results.NotFound();
});
app.Run();

public partial class Program;
