namespace Cliffly.Sessions;

public record CaptureSession
{
    public required Guid SessionId { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required string Status { get; init; }
    public required int FrameIntervalSeconds { get; init; }
    public int FrameCount { get; init; }
    public string? Error  { get; init; }
    public string VideoExtension { get; init; } = ".video";
    public string ReconstructionStatus { get; init; } = "none";
    public string? ReconstructionStage { get; init; }
    public int ReconstructionPercent { get; init; }
    public string? ReconstructionMessage { get; init; }
}
