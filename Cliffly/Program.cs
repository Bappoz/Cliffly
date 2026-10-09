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
var app = builder.Build();
if (string.IsNullOrEmpty(builder.Configuration["urls"])) app.Urls.Add("http://localhost:5000");
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
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
    FileStream stream;
    try { stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, FileOptions.Asynchronous); }
    catch (IOException) when (File.Exists(temporary))
    { return Results.Conflict(new { error = "Já existe um upload em andamento." }); }
    try
    {
        await using (stream)
        {
            if (File.Exists(destination)) return Results.Conflict(new { error = "Essa sessão já tem um vídeo." });
            await video.CopyToAsync(stream, cancellationToken);
        }
        File.Move(temporary, destination);
        var processing = session with { Status = "processing", Error = null };
        await store.SaveAsync(processing, cancellationToken);
        if (!worker.TryEnqueue(processing))
        {
            File.Delete(destination);
            await store.SaveAsync(session, CancellationToken.None);
            return Results.Json(new { error = "Fila cheia. Tente novamente em alguns segundos." }, statusCode: 503);
        }
        return Results.Accepted($"/sessions/{sessionId}", processing);
    }
    finally { if (File.Exists(temporary)) File.Delete(temporary); }
}).DisableAntiforgery();
app.MapGet("/sessions/{sessionId:guid}", async (Guid sessionId, CaptureSessionStore store, CancellationToken cancellationToken) =>
{
    var session = await store.TryGetAsync(sessionId, cancellationToken);
    return session is null ? Results.NotFound() : Results.Ok(session);
});
app.Run();

public partial class Program;
