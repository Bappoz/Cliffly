using System.Net;
using System.Net.Sockets;
using Cliffly.Sessions;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

// Permite conexão de dispositivos pelo WiFi
app.Urls.Add("http://0.0.0.0:5000");

var captureRoot = Path.Combine(app.Environment.ContentRootPath, "captures");
var sessionStore = new CaptureSessionStore(captureRoot);
var frameExtractor = new FrameExtractor();

// Descobre o IP local da rede WiFi
// E imprime no terminal
var localIp = Dns.GetHostEntry(Dns.GetHostName())
    .AddressList
    .FirstOrDefault(ip => ip.AddressFamily == AddressFamily.InterNetwork);


Console.WriteLine($"$ Backend rodando. Use este endereço no app: http://{localIp}:5000");

app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.MapPost("/sessions", () =>
{
    var session = sessionStore.Create();
    return Results.Created($"/sessions/{session.SessionId}", session);
});
app.MapPost("/sessions/{sessionId:guid}/video", async (Guid sessionId, IFormFile video) =>
{
    var session = sessionStore.TryGet(sessionId);
    if (session == null)
        return Results.NotFound();

    var videoPath = Path.Combine(sessionStore.GetSessionDirectory(sessionId), "video.mp4");
    
    if (File.Exists(videoPath))
        return Results.Conflict("Essa sessao ja tem um video.");
    
    await using var fileStream = File.Create(videoPath);
    await video.CopyToAsync(fileStream);

    var processing = session with { Status = "processing" };
    sessionStore.Save(processing);

    _ = Task.Run(async () =>
    {
        try
        {
            var isValid = await frameExtractor.IsValidVideoAsync(videoPath);
            if (!isValid)
            {
                sessionStore.Save(processing with { Status = "error", Error = "Video invalido ou nao decodificavel."});
                return;
            }
            var framesDir = Path.Combine(sessionStore.GetSessionDirectory(sessionId), "frames");
            var frameCount = await frameExtractor.ExtractFramesAsync(videoPath, framesDir, processing.FrameIntervalSeconds);
            
            sessionStore.Save(processing with { Status = "done", FrameCount = frameCount });
        }
        catch (Exception ex)
        {
            sessionStore.Save(processing with { Status = "error", Error = ex.Message });
        }
    });
    
    return Results.Ok(processing);
}).DisableAntiforgery();

app.MapGet("/sessions/{sessionId:guid}", (Guid sessionId) =>
{
    var session = sessionStore.TryGet(sessionId);
    return session is null ? Results.NotFound() : Results.Ok(session);
});

app.Run();
