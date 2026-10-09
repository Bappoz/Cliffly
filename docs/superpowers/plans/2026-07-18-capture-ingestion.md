# Captura + Ingestão Implementation Plan

> **Nota de execução:** este plano NÃO vai ser executado por um subagent nem por
> escrita automática de arquivos. O usuário pediu para aprender C#/.NET escrevendo
> o código com a própria mão — a IA vai apresentar o código tarefa por tarefa,
> explicado, direto na conversa, e o usuário digita/cola nos arquivos. Este
> documento é o roteiro/checklist que orienta a sequência, não um script pra rodar
> sozinho.

**Goal:** app MAUI (Android) grava um vídeo do ambiente e envia pro backend
ASP.NET Core, que extrai frames via FFmpeg e organiza tudo numa "capture session"
em disco — sem nenhum processamento de visão computacional ainda.

**Architecture:** dois projetos na solution (`Cliffly` = backend Web API mínima,
`Cliffly.MobileApp` = app MAUI). Comunicação HTTP direta na rede local (usuário
digita IP:porta, sem discovery). Backend usa sistema de arquivos (sem banco de
dados) para armazenar `captures/{sessionId}/`.

**Tech Stack:** .NET 10, ASP.NET Core Minimal APIs, .NET MAUI (target Android),
FFmpeg (processo externo via `System.Diagnostics.Process`).

## Global Constraints

- Sem EmguCV nesta fase (reservado pro sub-projeto de calibração — risco de lib
  nativa no Linux documentado no spec).
- Sem banco de dados — tudo em `captures/{sessionId}/` no sistema de arquivos.
- Sem service discovery — IP:porta do backend é configurado manualmente no app.
- Plataforma mobile: Android apenas (Tab S7). Sem suporte iOS nesta fase.
- Intervalo de extração de frames fixo: 1 frame/segundo (hardcoded).
- Spec de referência: `docs/superpowers/specs/2026-07-18-capture-ingestion-design.md`

---

## File Structure

```
Cliffly.sln
Cliffly/                              # backend
  Cliffly.csproj                      # SDK: Microsoft.NET.Sdk.Web
  Program.cs                          # minimal API: rotas + wiring
  Sessions/
    CaptureSession.cs                 # record do manifest + (de)serialização
    CaptureSessionStore.cs            # cria/lê pastas de sessão em disco
    FrameExtractor.cs                 # invoca ffmpeg/ffprobe via Process
Cliffly.MobileApp/                    # novo projeto MAUI
  Cliffly.MobileApp.csproj            # TargetFrameworks: net10.0-android
  MainPage.xaml / MainPage.xaml.cs    # única tela: config + gravar + enviar
  Platforms/Android/AndroidManifest.xml  # permissões de câmera/mídia
```

Backend fica em Minimal API (tudo em `Program.cs` + duas classes de apoio) —
YAGNI: não há necessidade de Controllers/DI complexo pra 3 endpoints.

---

### Task 1: Backend — converter console app pra Web API mínima

**Files:**
- Modify: `Cliffly/Cliffly.csproj`
- Modify: `Cliffly/Program.cs`

**Interfaces:**
- Produces: servidor HTTP rodando em `http://0.0.0.0:5000` (todas as interfaces
  de rede, não só localhost — necessário pro tablet alcançar via wifi), endpoint
  `GET /health` retornando `200 OK`. Imprime no console o IP local da máquina na
  rede (pra digitar no app depois, Task 7).

**O que ensina:** diferença entre SDK `Microsoft.NET.Sdk` (console) e
`Microsoft.NET.Sdk.Web` (ASP.NET Core), o que é `WebApplication.CreateBuilder`,
Kestrel, minimal API routing (`app.MapGet`), por que bindar em `0.0.0.0` em vez
de `localhost` quando outro device precisa alcançar o servidor pela rede.

**Deliverable testável:** `dotnet run` sobe o servidor, `curl http://localhost:5000/health`
retorna 200.

---

### Task 2: Backend — modelo de sessão + `POST /sessions`

**Files:**
- Create: `Cliffly/Sessions/CaptureSession.cs`
- Create: `Cliffly/Sessions/CaptureSessionStore.cs`
- Modify: `Cliffly/Program.cs`

**Interfaces:**
- Produces (`CaptureSession` record): `SessionId (Guid)`, `CreatedAt (DateTimeOffset)`,
  `Status ("pending"|"processing"|"done"|"error")`, `FrameIntervalSeconds (int)`,
  `FrameCount (int)`, `Error (string?)` — serializado como `manifest.json`.
- Produces (`CaptureSessionStore`): `Create() -> CaptureSession`,
  `TryGet(Guid sessionId) -> CaptureSession?`, `Save(CaptureSession session)`,
  `GetSessionDirectory(Guid sessionId) -> string`.
- Endpoint: `POST /sessions` → cria pasta `captures/{guid}/`, grava `manifest.json`
  inicial (`status: "pending"`), retorna `201` com o JSON da sessão.

**O que ensina:** `record` types em C#, `System.Text.Json` (serialize/deserialize),
`Directory.CreateDirectory`, `Guid.NewGuid()`, binding de resposta JSON em minimal API.

**Deliverable testável:** `curl -X POST http://localhost:5000/sessions` retorna
JSON com `sessionId`, e a pasta `captures/{sessionId}/manifest.json` existe no disco.

---

### Task 3: Backend — upload do vídeo (`POST /sessions/{sessionId}/video`)

**Files:**
- Modify: `Cliffly/Program.cs`

**Interfaces:**
- Consumes: `CaptureSessionStore.TryGet`, `GetSessionDirectory` (Task 2).
- Endpoint: `POST /sessions/{sessionId}/video`, multipart/form-data, campo `video`.
  - `404` se `sessionId` não existe.
  - `409` se `video.mp4` já existe na pasta da sessão (não sobrescreve).
  - `200` + dispara extração em background (Task 4) e salva o arquivo em
    `captures/{sessionId}/video.mp4`.

**O que ensina:** `IFormFile` / `IFormFileCollection` em minimal API, streams
(`CopyToAsync`), validação de path traversal (usar sempre `sessionId` validado
como Guid, nunca concatenar string vinda do usuário direto no path).

**Deliverable testável:** `curl -F "video=@teste.mp4" http://localhost:5000/sessions/{id}/video`
grava o arquivo, um segundo curl igual retorna 409.

---

### Task 4: Backend — extração de frames via FFmpeg

**Files:**
- Create: `Cliffly/Sessions/FrameExtractor.cs`
- Modify: `Cliffly/Program.cs`

**Interfaces:**
- Consumes: `CaptureSession`, `CaptureSessionStore.Save` (Task 2).
- Produces (`FrameExtractor`): `Task<bool> IsValidVideoAsync(string videoPath)` →
  roda `ffprobe -v error {video}` via `Process.Start`, retorna `true` se o exit
  code for 0 (arquivo decodificável).
- Produces (`FrameExtractor`): `Task<int> ExtractFramesAsync(string videoPath, string framesDir, int intervalSeconds)`
  → roda `ffmpeg -i {video} -vf fps=1/{intervalSeconds} {framesDir}/%03d.jpg`
  via `Process.Start`, aguarda conclusão, retorna a contagem de frames gerados
  (`Directory.GetFiles(framesDir).Length`).
- Ao terminar, atualiza `manifest.json` via `CaptureSessionStore.Save`:
  `status: "error"` + `Error` se `IsValidVideoAsync` retornar `false` (não chega a
  tentar extrair); `status: "done"` + `frameCount` se a extração funcionar;
  `status: "error"` + `Error` se `ExtractFramesAsync` lançar exceção.

**O que ensina:** `System.Diagnostics.Process` (rodar binário externo, capturar
stdout/stderr, `WaitForExitAsync`, ler `ExitCode`), disparar trabalho em background
sem bloquear a resposta HTTP (`Task.Run` a partir do endpoint), tratamento de erro
sem derrubar o processo do servidor (`try/catch` em volta do background work).

**Deliverable testável:** rodar `FrameExtractor` isolado (ex: num teste de console
ou teste unitário) contra um `.mp4` de exemplo e conferir que os `.jpg` aparecem
na pasta.

---

### Task 5: Backend — consulta de status (`GET /sessions/{sessionId}`)

**Files:**
- Modify: `Cliffly/Program.cs`

**Interfaces:**
- Consumes: `CaptureSessionStore.TryGet` (Task 2).
- Endpoint: `GET /sessions/{sessionId}` → `404` se não existe, senão `200` com o
  JSON completo do manifest (status atual, frameCount, error se houver).

**O que ensina:** fechamento do ciclo de polling — como o cliente (app) sabe
quando a extração terminou sem precisar de WebSocket/SignalR (over-engineering
pra esse estágio).

**Deliverable testável:** `curl http://localhost:5000/sessions/{id}` reflete o
status indo de `pending` → `processing` → `done` conforme a extração roda.

---

### Task 6: App MAUI — criar o projeto (Android)

**Files:**
- Create: `Cliffly.MobileApp/` (projeto novo via `dotnet new maui`)
- Modify: `Cliffly.sln` (adicionar o projeto)

**Interfaces:**
- Produces: app instalável no emulador Android e no Tab S7, tela em branco com
  um texto "Cliffly".

**O que ensina:** estrutura de um projeto MAUI (`Platforms/`, `MauiProgram.cs`,
`App.xaml`), diferença entre rodar no emulador vs. device físico (ativar "opções
do desenvolvedor" + depuração USB/wifi no Tab S7), `dotnet build -f net10.0-android`.

**Deliverable testável:** app abre no Tab S7 mostrando a tela em branco.

---

### Task 7: App MAUI — tela de configuração (IP:porta do backend)

**Files:**
- Modify: `Cliffly.MobileApp/MainPage.xaml`
- Modify: `Cliffly.MobileApp/MainPage.xaml.cs`

**Interfaces:**
- Produces: `Preferences.Set("backend_url", string)` / `Preferences.Get("backend_url", "")`
  persistido entre execuções do app.

**O que ensina:** XAML básico (`Entry`, `Button`, `VerticalStackLayout`),
code-behind e event handlers (`Clicked`), `Microsoft.Maui.Storage.Preferences`
como storage local simples (sem banco).

**Deliverable testável:** digitar um IP, fechar e reabrir o app, o campo continua
preenchido.

---

### Task 8: App MAUI — gravar vídeo

**Files:**
- Modify: `Cliffly.MobileApp/MainPage.xaml`
- Modify: `Cliffly.MobileApp/MainPage.xaml.cs`
- Modify: `Cliffly.MobileApp/Platforms/Android/AndroidManifest.xml`

**Interfaces:**
- Consumes: nenhuma (self-contained).
- Produces: `FileResult?` do vídeo gravado guardado em campo local da página,
  disponível pra Task 9 fazer upload.

**O que ensina:** `MediaPicker.Default.CaptureVideoAsync()`, permissões Android
em tempo de manifest (`CAMERA`, `READ_MEDIA_VIDEO`) vs. em tempo de execução
(MAUI trata o request de permissão automaticamente na chamada), `FileResult.OpenReadAsync()`.

**Deliverable testável:** botão "Gravar" abre a câmera nativa do Tab S7, grava
um vídeo curto, volta pro app mostrando "Vídeo pronto: N segundos".

---

### Task 9: App MAUI — enviar vídeo pro backend

**Files:**
- Modify: `Cliffly.MobileApp/MainPage.xaml`
- Modify: `Cliffly.MobileApp/MainPage.xaml.cs`

**Interfaces:**
- Consumes: `Preferences.Get("backend_url")` (Task 7), `FileResult` do vídeo (Task 8),
  endpoints `POST /sessions` e `POST /sessions/{sessionId}/video` (Tasks 2 e 3).
- Produces: feedback de sucesso/erro na UI, retry manual se falhar.

**O que ensina:** `HttpClient`, `MultipartFormDataContent` / `StreamContent` pra
subir arquivo binário, `async/await` numa UI (não travar a thread principal),
tratamento de erro de rede sem derrubar o app.

**Deliverable testável:** gravar um vídeo no Tab S7, tocar "Enviar", ver o arquivo
aparecer em `captures/{sessionId}/video.mp4` no PC.

---

### Task 10: Teste end-to-end real

**Files:** nenhum arquivo novo — validação manual.

**Interfaces:** N/A.

**O que ensina:** debugar o pipeline completo junto (rede local, firewall, logs
do backend, logs do app via `adb logcat` se algo travar).

**Deliverable testável:** gravar um vídeo real girando ao redor de um objeto/cômodo
no Tab S7, enviar, e ver `captures/{sessionId}/frames/001.jpg, 002.jpg...` aparecerem
no PC com `status: "done"` no manifest.

---

## Ordem recomendada

Backend primeiro (Tasks 1→5, testável 100% via curl, sem depender do app) — dá
feedback rápido e ensina ASP.NET Core isolado. Depois o app (Tasks 6→9), que já
consome o backend funcionando. Task 10 fecha o ciclo.
