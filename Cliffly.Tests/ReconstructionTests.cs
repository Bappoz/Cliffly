using System.Net;
using System.Net.Http.Json;
using Cliffly.Sessions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Cliffly.Tests;

public sealed class ReconstructionTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"cliffly-reconstruction-tests-{Guid.NewGuid()}");
    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }

    [Fact]
    public async Task JobRejectsDuplicatesPersistsProgressAndPublishesOnlyFinishedWorld()
    {
        var runner = new TestRunner();
        await using var factory = new Factory(root, runner);
        using var client = factory.CreateClient();
        var store = factory.Services.GetRequiredService<CaptureSessionStore>();
        var session = await store.CreateAsync();
        await store.SaveAsync(session with { Status = "done", FrameCount = 4 });
        var url = $"/sessions/{session.SessionId}";
        var responses = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => client.PostAsync(url + "/reconstruction", null)));
        Assert.Single(responses, r => r.StatusCode == HttpStatusCode.Accepted);
        Assert.Equal(7, responses.Count(r => r.StatusCode == HttpStatusCode.Conflict));
        await runner.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var active = (await client.GetFromJsonAsync<CaptureSession>(url))!;
        Assert.Equal("processing", active.ReconstructionStatus);
        Assert.Equal(42, active.ReconstructionPercent);
        Assert.Equal(HttpStatusCode.Conflict, (await client.GetAsync(url + "/world")).StatusCode);
        runner.Release.TrySetResult();
        var complete = await WaitForCompletion(client, url);
        Assert.Equal("complete", complete.ReconstructionStatus);
        var world = await client.GetAsync(url + "/world");
        Assert.Equal(HttpStatusCode.OK, world.StatusCode);
        Assert.Contains("voxel-world", await world.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsync(url + "/reconstruction", null)).StatusCode);
    }

    [Fact]
    public async Task FailureIsPersistedAndCanBeRetried()
    {
        var runner = new TestRunner { Fail = true };
        runner.Release.TrySetResult();
        await using var factory = new Factory(root, runner);
        using var client = factory.CreateClient();
        var store = factory.Services.GetRequiredService<CaptureSessionStore>();
        var session = await store.CreateAsync();
        await store.SaveAsync(session with { Status = "done", FrameCount = 4 });
        var url = $"/sessions/{session.SessionId}";
        Assert.Equal(HttpStatusCode.Accepted, (await client.PostAsync(url + "/reconstruction", null)).StatusCode);
        var failed = await WaitForCompletion(client, url);
        Assert.Equal("failed", failed.ReconstructionStatus);
        Assert.Contains("textura", failed.ReconstructionMessage);
        runner.Fail = false;
        Assert.Equal(HttpStatusCode.Accepted, (await client.PostAsync(url + "/reconstruction", null)).StatusCode);
        Assert.Equal("complete", (await WaitForCompletion(client, url)).ReconstructionStatus);
    }

    [Fact]
    public async Task MissingAndUnpreparedSessionsAreRejected()
    {
        await using var factory = new Factory(root, new TestRunner());
        using var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsync($"/sessions/{Guid.NewGuid()}/reconstruction", null)).StatusCode);
        var session = (await client.PostAsync("/sessions", null)).Content;
        var created = (await session.ReadFromJsonAsync<CaptureSession>())!;
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsync($"/sessions/{created.SessionId}/reconstruction", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/sessions/{Guid.NewGuid()}/world")).StatusCode);
    }

    [Theory]
    [InlineData("queued")]
    [InlineData("processing")]
    public async Task RestartRecoversInterruptedReconstruction(string status)
    {
        var store = new CaptureSessionStore(root);
        var session = await store.CreateAsync();
        await store.SaveAsync(session with { Status = "done", FrameCount = 4, ReconstructionStatus = status });
        await store.RecoverInterruptedAsync(CancellationToken.None);
        var recovered = (await store.TryGetAsync(session.SessionId))!;
        Assert.Equal("done", recovered.Status);
        Assert.Equal("failed", recovered.ReconstructionStatus);
        Assert.Contains("reinício", recovered.ReconstructionMessage);
    }

    [Fact]
    public async Task SavedVideoSupportsDownloadAndRangePreview()
    {
        await using var factory = new Factory(root, new TestRunner());
        using var client = factory.CreateClient();
        var store = factory.Services.GetRequiredService<CaptureSessionStore>();
        var session = await store.CreateAsync();
        await store.SaveAsync(session with { Status = "done", FrameCount = 4, VideoExtension = ".webm" });
        await File.WriteAllBytesAsync(Path.Combine(store.GetSessionDirectory(session.SessionId), "video.mp4"), [1, 2, 3, 4, 5, 6]);
        var url = $"/sessions/{session.SessionId}/video";
        var download = await client.GetAsync(url);
        Assert.Equal("video/webm", download.Content.Headers.ContentType!.MediaType);
        Assert.Contains(".webm", download.Content.Headers.ContentDisposition!.FileNameStar);
        using var request = new HttpRequestMessage(HttpMethod.Get, url + "?preview=true");
        request.Headers.Range = new(0, 2);
        var preview = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.PartialContent, preview.StatusCode);
        Assert.Null(preview.Content.Headers.ContentDisposition);
        Assert.Equal(new byte[] { 1, 2, 3 }, await preview.Content.ReadAsByteArrayAsync());
    }

    private static async Task<CaptureSession> WaitForCompletion(HttpClient client, string url)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (true)
        {
            var session = (await client.GetFromJsonAsync<CaptureSession>(url, timeout.Token))!;
            if (session.ReconstructionStatus is "complete" or "failed") return session;
            await Task.Delay(30, timeout.Token);
        }
    }

    private sealed class TestRunner : IReconstructionRunner
    {
        public bool IsAvailable => true;
        public bool Fail { get; set; }
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public async Task RunAsync(string directory, Func<ReconstructionProgress, Task> onProgress, CancellationToken cancellationToken)
        {
            await onProgress(new("poses", 42, "Estimando câmeras"));
            Started.TrySetResult();
            await Release.Task.WaitAsync(cancellationToken);
            if (Fail) throw new InvalidOperationException("Pouca textura para reconstruir.");
            var output = Path.Combine(directory, "reconstruction");
            Directory.CreateDirectory(output);
            await File.WriteAllTextAsync(Path.Combine(output, "world.json"), "{\"version\":2,\"kind\":\"voxel-world\",\"points\":[0,0,0,1,255,0,0]}", cancellationToken);
        }
    }

    private sealed class Factory(string directory, IReconstructionRunner runner) : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseSetting("CaptureRoot", directory);
            builder.ConfigureServices(services => services.Replace(ServiceDescriptor.Singleton(runner)));
        }
    }
}
