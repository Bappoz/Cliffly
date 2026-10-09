using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Cliffly.Sessions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Cliffly.Tests;

public sealed class GuidedScanTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"cliffly-guide-tests-{Guid.NewGuid()}");
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }

    [Fact]
    public async Task ScanProcessesFramesAndPersistsWorldAfterStop()
    {
        await using var factory = CreateFactory();
        using var client = factory.CreateClient();
        var scan = await Create(client);
        Assert.Equal(HttpStatusCode.Conflict, (await client.GetAsync($"/scans/{scan.ScanId}/world")).StatusCode);
        var response = await client.PostAsync($"/scans/{scan.ScanId}/frames", Frame([1, 2, 3]));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var updated = (await response.Content.ReadFromJsonAsync<GuidedScanState>())!;
        Assert.Equal(1, updated.Preview!.Value.GetProperty("revision").GetInt32());
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync($"/scans/{scan.ScanId}/world")).StatusCode);
        var stop = await client.PostAsync($"/scans/{scan.ScanId}/stop", null);
        Assert.Equal("stopped", (await stop.Content.ReadFromJsonAsync<GuidedScanState>())!.Status);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync($"/scans/{scan.ScanId}/world")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsync($"/scans/{scan.ScanId}/frames", Frame([1]))).StatusCode);
        var next = await Create(client);
        Assert.NotEqual(scan.ScanId, next.ScanId);
        await client.PostAsync($"/scans/{next.ScanId}/stop", null);
    }

    [Fact]
    public async Task ScanAndFrameConcurrencyAreBounded()
    {
        await using var factory = CreateFactory(delay: .5);
        using var client = factory.CreateClient();
        var scans = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => client.PostAsync("/scans", null)));
        Assert.Single(scans, r => r.StatusCode == HttpStatusCode.Created);
        Assert.Equal(3, scans.Count(r => r.StatusCode == HttpStatusCode.Conflict));
        var scan = (await scans.Single(r => r.StatusCode == HttpStatusCode.Created).Content.ReadFromJsonAsync<GuidedScanState>())!;
        var frames = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => client.PostAsync($"/scans/{scan.ScanId}/frames", Frame([1]))));
        Assert.Single(frames, r => r.StatusCode == HttpStatusCode.OK);
        Assert.Equal(3, frames.Count(r => r.StatusCode == HttpStatusCode.Conflict));
        await client.PostAsync($"/scans/{scan.ScanId}/stop", null);
    }

    [Fact]
    public async Task InvalidFramesAndUnknownScansAreRejected()
    {
        await using var factory = CreateFactory();
        using var client = factory.CreateClient();
        var scan = await Create(client);
        var url = $"/scans/{scan.ScanId}/frames";
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsync(url, new StringContent("not a JPEG"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsync(url, Frame([]))).StatusCode);
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, (await client.PostAsync(url, Frame(new byte[1024*1024+1]))).StatusCode);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await client.PostAsync(url, Frame([0]))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/scans/{Guid.NewGuid()}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsync($"/scans/{Guid.NewGuid()}/frames", Frame([1]))).StatusCode);
        await client.PostAsync($"/scans/{scan.ScanId}/stop", null);
    }

    [Fact]
    public async Task InactiveWorkerExpiresAndFreesCapacity()
    {
        await using var factory = CreateFactory(idle: 2);
        using var client = factory.CreateClient();
        var scan = await Create(client);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(7));
        while ((await client.GetFromJsonAsync<GuidedScanState>($"/scans/{scan.ScanId}", timeout.Token))!.Status == "active")
            await Task.Delay(100, timeout.Token);
        var expired = (await client.GetFromJsonAsync<GuidedScanState>($"/scans/{scan.ScanId}"))!;
        Assert.Equal("expired", expired.Status);
        var next = await Create(client);
        await client.PostAsync($"/scans/{next.ScanId}/stop", null);
    }

    [Fact]
    public async Task StopDuringFrameProcessingDoesNotDeadlock()
    {
        await using var factory = CreateFactory(delay: 3);
        using var client = factory.CreateClient();
        var scan = await Create(client);
        var frame = client.PostAsync($"/scans/{scan.ScanId}/frames", Frame([1]));
        await Task.Delay(200);
        var stop = await client.PostAsync($"/scans/{scan.ScanId}/stop", null).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(HttpStatusCode.OK, stop.StatusCode);
        Assert.Equal("stopped", (await client.GetFromJsonAsync<GuidedScanState>($"/scans/{scan.ScanId}"))!.Status);
        await frame;
    }

    [Fact]
    public async Task RestartMarksOldActiveScanAsInterrupted()
    {
        Directory.CreateDirectory(Path.Combine(root, "scans"));
        var id = Guid.NewGuid(); var directory = Path.Combine(root, "scans", id.ToString()); Directory.CreateDirectory(directory);
        var state = new GuidedScanState(id, "active", DateTimeOffset.UtcNow, DateTimeOffset.UtcNow);
        await File.WriteAllTextAsync(Path.Combine(directory, "scan.json"), JsonSerializer.Serialize(state, JsonOptions));
        await using var factory = CreateFactory(); using var client = factory.CreateClient();
        Assert.Equal("interrupted", (await client.GetFromJsonAsync<GuidedScanState>($"/scans/{id}"))!.Status);
    }

    private Factory CreateFactory(double delay = 0, int idle = 30)
    {
        Directory.CreateDirectory(root);
        var script = Path.Combine(root, "fixture.py");
        // Protocol fixture: no CV simulation claims. Real geometry is tested in Python/browser.
        File.WriteAllText(script, $$"""
            import sys,json,time,argparse
            from pathlib import Path
            parser=argparse.ArgumentParser();parser.add_argument('--output');args=parser.parse_args()
            output=Path(args.output)
            for line in sys.stdin:
                frame=json.loads(line)
                if Path(frame['frame']).read_bytes()==b'\0':
                    print(json.dumps({'error':'Invalid JPEG'}),flush=True);continue
                time.sleep({{delay.ToString(System.Globalization.CultureInfo.InvariantCulture)}})
                (output/'world.json').write_text(json.dumps({'version':2,'kind':'voxel-world','voxelSize':1,'points':[0,0,-5,1,100,120,50],'cameras':[]}))
                print(json.dumps({'revision':1,'tracking':'tracking','message':'Observe de outro ângulo','blocks':1}),flush=True)
            """);
        return new(root, script, idle);
    }

    private static ByteArrayContent Frame(byte[] data)
    {
        var body = new ByteArrayContent(data); body.Headers.ContentType = new("image/jpeg"); return body;
    }
    private static async Task<GuidedScanState> Create(HttpClient client)
    {
        var response = await client.PostAsync("/scans", null);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<GuidedScanState>())!;
    }
    private sealed class Factory(string directory, string script, int idle) : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(IWebHostBuilder builder) => builder.UseSetting("CaptureRoot", directory)
            .UseSetting("Reconstruction:Python", OperatingSystem.IsWindows() ? "python" : "python3")
            .UseSetting("Reconstruction:GuideScript", script).UseSetting("GuidedScan:IdleSeconds", idle.ToString());
    }
}
