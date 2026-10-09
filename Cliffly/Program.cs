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
builder.Services.AddSingleton<GuidedScanManager>();
builder.Services.AddHostedService(provider => provider.GetRequiredService<GuidedScanManager>());
var app = builder.Build();
if (string.IsNullOrEmpty(builder.Configuration["urls"])) app.Urls.Add("http://localhost:5000");
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapGet("/health", (IReconstructionRunner runner, GuidedScanManager scans) => Results.Ok(new { status = "ok", reconstructionAvailable = runner.IsAvailable, guidedCaptureAvailable = scans.IsAvailable }));
app.MapPost("/scans", async (GuidedScanManager scans, CancellationToken cancellationToken) =>
{
    try
    {
        var scan = await scans.CreateAsync(cancellationToken);
        return scan is null ? Results.Conflict(new { error = "Já existe uma prévia ativa. Aguarde ou grave sem prévia." })
            : Results.Created($"/scans/{scan.ScanId}", scan);
    }
    catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
    { return Results.Json(new { error = "Prévia indisponível. A gravação pode continuar sem prévia." }, statusCode: 503); }
});
app.MapGet("/scans/{scanId:guid}", async (Guid scanId, GuidedScanManager scans, CancellationToken cancellationToken) =>
{
    var state = await scans.GetAsync(scanId, cancellationToken);
    return state is null ? Results.NotFound() : Results.Ok(state);
});
app.MapPost("/scans/{scanId:guid}/frames", async (Guid scanId, HttpRequest request, GuidedScanManager scans, CancellationToken cancellationToken) =>
{
    const int limit = 1024 * 1024;
    if (request.ContentType != "image/jpeg") return Results.BadRequest(new { error = "Envie um frame JPEG." });
    if (request.ContentLength > limit) return Results.StatusCode(413);
    using var memory = new MemoryStream();
    var buffer = new byte[16384];
    int count;
    while ((count = await request.Body.ReadAsync(buffer, cancellationToken)) > 0)
    {
        if (memory.Length + count > limit) return Results.StatusCode(413);
        memory.Write(buffer, 0, count);
    }
    if (memory.Length == 0) return Results.BadRequest(new { error = "Frame vazio." });
    try { return Results.Ok(await scans.ProcessAsync(scanId, memory.ToArray(), cancellationToken)); }
    catch (KeyNotFoundException) { return Results.NotFound(); }
    catch (GuidedScanManager.ScanBusyException) { return Results.Conflict(new { error = "Um frame já está sendo processado." }); }
    catch (InvalidDataException) { return Results.UnprocessableEntity(new { error = "JPEG ilegível ou acima do limite de resolução." }); }
    catch (InvalidOperationException ex) { return Results.Json(new { error = ex.Message }, statusCode: 503); }
});
app.MapGet("/scans/{scanId:guid}/world", async (Guid scanId, GuidedScanManager scans, CancellationToken cancellationToken) =>
{
    var state = await scans.GetAsync(scanId, cancellationToken);
    var path = Path.Combine(scans.GetDirectory(scanId), "world.json");
    return state is null ? Results.NotFound() : File.Exists(path)
        ? Results.File(path, "application/json") : Results.Conflict(new { error = "A prévia ainda precisa de vistas com deslocamento." });
});
app.MapPost("/scans/{scanId:guid}/stop", async (Guid scanId, GuidedScanManager scans, CancellationToken cancellationToken) =>
{
    if (await scans.GetAsync(scanId, cancellationToken) is null) return Results.NotFound();
    await scans.StopScanAsync(scanId);
    return Results.Ok(await scans.GetAsync(scanId, cancellationToken));
});
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
app.MapGet("/sessions/{sessionId:guid}/video", async (Guid sessionId, bool? preview, CaptureSessionStore store, CancellationToken cancellationToken) =>
{
    var session = await store.TryGetAsync(sessionId, cancellationToken);
    var path = Path.Combine(store.GetSessionDirectory(sessionId), "video.mp4");
    var contentType = session?.VideoExtension switch { ".mp4" => "video/mp4", ".webm" => "video/webm", ".mov" => "video/quicktime", _ => "application/octet-stream" };
    return session is not null && session.Status == "done" && File.Exists(path)
        ? Results.File(path, contentType, preview == true ? null : $"cliffly-{sessionId}{session.VideoExtension}", enableRangeProcessing: true)
        : Results.NotFound();
});
app.Run();

public partial class Program;
