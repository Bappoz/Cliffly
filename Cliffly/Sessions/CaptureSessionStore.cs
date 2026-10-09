using System.Text.Json;

namespace Cliffly.Sessions;

public class CaptureSessionStore
{
    private readonly string _captureRoot;

    public CaptureSessionStore(string captureRoot)
    {
        _captureRoot = captureRoot;
    }
    
    public string GetSessionDirectory(Guid sessionId) => 
        Path.Combine(_captureRoot, sessionId.ToString());

    public CaptureSession Create()
    {
        var session = new CaptureSession
        {
            SessionId = Guid.NewGuid(),
            CreatedAt = DateTimeOffset.UtcNow,
            Status = "pending",
            FrameIntervalSeconds = 1,
            FrameCount = 0,
            Error = null,
        };

        Directory.CreateDirectory(GetSessionDirectory(session.SessionId));
        Save(session);
        
        return session;
    }

    public CaptureSession? TryGet(Guid sessionId)
    {
        var manifestPath = Path.Combine(GetSessionDirectory(sessionId), "manifest.json");

        if (!File.Exists(manifestPath))
        {
            return null;
        }
        var json = File.ReadAllText(manifestPath);
        return JsonSerializer.Deserialize<CaptureSession>(json);
    }

    public void Save(CaptureSession session)
    {
        var manifestPath = Path.Combine(GetSessionDirectory(session.SessionId), "manifest.json");
        var json = JsonSerializer.Serialize(session, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(manifestPath, json);
    }
}
