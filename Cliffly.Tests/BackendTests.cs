using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using Cliffly.Sessions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Cliffly.Tests;

public sealed class BackendTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"cliffly-tests-{Guid.NewGuid()}");
    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }

    [Fact]
    public async Task StoreRoundTripsAndMissingSessionIsNull()
    {
        var store = new CaptureSessionStore(root);
        Assert.Null(await store.TryGetAsync(Guid.NewGuid()));
        var session = await store.CreateAsync();
        Assert.Equal(session, await store.TryGetAsync(session.SessionId));
        Assert.Equal("pending", session.Status);
    }

    [Fact]
    public async Task ConcurrentReadsNeverSeePartialManifest()
    {
        var store = new CaptureSessionStore(root);
        var session = await store.CreateAsync();
        var writes = Task.Run(async () =>
        {
            for (var i = 0; i < 100; i++) await store.SaveAsync(session with { FrameCount = i });
        });
        for (var i = 0; i < 100; i++) Assert.NotNull(await store.TryGetAsync(session.SessionId));
        await writes;
        Assert.Equal(99, (await store.TryGetAsync(session.SessionId))!.FrameCount);
        Assert.Empty(Directory.GetFiles(store.GetSessionDirectory(session.SessionId), "*.tmp"));
    }

    [Fact]
    public async Task InterruptedSessionsAreRecoveredWithoutChangingFinishedSessions()
    {
        var store = new CaptureSessionStore(root);
        var active = await store.CreateAsync();
        var complete = await store.CreateAsync();
        await store.SaveAsync(active with { Status = "processing" });
        await store.SaveAsync(complete with { Status = "done" });
        await store.RecoverInterruptedAsync(CancellationToken.None);
        Assert.Equal("error", (await store.TryGetAsync(active.SessionId))!.Status);
        Assert.Equal("done", (await store.TryGetAsync(complete.SessionId))!.Status);
    }

    [Fact]
    public async Task ExtractorDecodesRealVideoAndRejectsAudioOnly()
    {
        Directory.CreateDirectory(root);
        var video = Path.Combine(root, "video with spaces.mp4");
        var audio = Path.Combine(root, "audio.wav");
        await Ffmpeg("-f", "lavfi", "-i", "color=c=green:s=64x48:r=10", "-t", "2", "-pix_fmt", "yuv420p", video);
        await Ffmpeg("-f", "lavfi", "-i", "sine=frequency=440", "-t", "1", audio);
        var extractor = new FrameExtractor();
        Assert.True(await extractor.IsValidVideoAsync(video));
        Assert.False(await extractor.IsValidVideoAsync(audio));
        Assert.Equal(2, await extractor.ExtractFramesAsync(video, Path.Combine(root, "frames"), 1));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => extractor.ExtractFramesAsync(video, root, 0));
        using var canceled = new CancellationTokenSource();
        canceled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => extractor.IsValidVideoAsync(video, canceled.Token));
    }

    [Fact]
    public async Task HealthSessionAndUnknownRoutesWork()
    {
        await using var factory = new Factory(root);
        using var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/health")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/sessions/{Guid.NewGuid()}")).StatusCode);
        var response = await client.PostAsync("/sessions", null);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var session = await response.Content.ReadFromJsonAsync<CaptureSession>();
        Assert.Equal(session, await client.GetFromJsonAsync<CaptureSession>(response.Headers.Location));
    }

    [Fact]
    public async Task EmptyUploadRejectedAndInvalidVideoBecomesError()
    {
        await using var factory = new Factory(root);
        using var client = factory.CreateClient();
        var session = await (await client.PostAsync("/sessions", null)).Content.ReadFromJsonAsync<CaptureSession>();
        var url = $"/sessions/{session!.SessionId}/video";
        using var empty = Upload([]);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsync(url, empty)).StatusCode);
        using var invalid = Upload([1, 2, 3]);
        Assert.Equal(HttpStatusCode.Accepted, (await client.PostAsync(url, invalid)).StatusCode);
        var completed = await Poll(client, session.SessionId);
        Assert.Equal("error", completed.Status);
        Assert.NotNull(completed.Error);
        using var duplicate = Upload([1]);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsync(url, duplicate)).StatusCode);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public async Task RealUploadCompletesAndConcurrentUploadCannotOverwrite(int iteration)
    {
        Directory.CreateDirectory(root);
        var video = Path.Combine(root, $"source-{iteration}.mp4");
        await Ffmpeg("-f", "lavfi", "-i", "testsrc2=s=64x48:r=10", "-t", "2", video);
        await using var factory = new Factory(root);
        using var client = factory.CreateClient();
        var session = await (await client.PostAsync("/sessions", null)).Content.ReadFromJsonAsync<CaptureSession>();
        var bytes = await File.ReadAllBytesAsync(video);
        using var first = Upload(bytes);
        using var second = Upload(bytes);
        var responses = await Task.WhenAll(client.PostAsync($"/sessions/{session!.SessionId}/video", first), client.PostAsync($"/sessions/{session.SessionId}/video", second));
        Assert.Single(responses, r => r.StatusCode == HttpStatusCode.Accepted);
        Assert.Single(responses, r => r.StatusCode == HttpStatusCode.Conflict);
        var result = await Poll(client, session.SessionId);
        Assert.Equal("done", result.Status);
        Assert.Equal(2, result.FrameCount);
        Assert.Equal(bytes, await File.ReadAllBytesAsync(Path.Combine(root, session.SessionId.ToString(), "video.mp4")));
    }

    private static MultipartFormDataContent Upload(byte[] bytes)
    {
        var form = new MultipartFormDataContent();
        form.Add(new ByteArrayContent(bytes), "video", "sample.mp4");
        return form;
    }

    private static async Task<CaptureSession> Poll(HttpClient client, Guid id)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        while (true)
        {
            var session = (await client.GetFromJsonAsync<CaptureSession>($"/sessions/{id}", timeout.Token))!;
            if (session.Status != "processing") return session;
            await Task.Delay(50, timeout.Token);
        }
    }

    private static async Task Ffmpeg(params string[] arguments)
    {
        using var process = new Process { StartInfo = new ProcessStartInfo("ffmpeg") { RedirectStandardError = true } };
        process.StartInfo.ArgumentList.Add("-v"); process.StartInfo.ArgumentList.Add("error");
        foreach (var argument in arguments) process.StartInfo.ArgumentList.Add(argument);
        process.Start();
        var error = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        Assert.True(process.ExitCode == 0, await error);
    }

    private sealed class Factory(string directory) : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(IWebHostBuilder builder) => builder.UseSetting("CaptureRoot", directory);
    }
}
