# Cliffly — Sub-projeto 1: Captura de Vídeo + Ingestão

## Contexto do projeto (visão geral)

Objetivo final: pipeline em C# que conecta a câmera de um celular/tablet a um backend
que reconstrói um modelo 3D do ambiente capturado, usando EmguCV nas etapas de visão
computacional.

Objetivo declarado do usuário para este projeto: **aprendizado profundo** de visão
computacional, geometria 3D e C#/.NET — não é para chegar rápido num produto, é para
entender os fundamentos. Tanto C#/.NET quanto visão computacional são novos para o
usuário, então o projeto é decomposto em fases incrementais e ensináveis.

Ambiente de dev: Arch Linux, .NET 10 SDK instalado, sem Mac disponível como build host.
Dispositivo de captura: Samsung Galaxy Tab S7 (Android).

## Achado técnico crítico (risco de arquitetura)

Os pacotes de runtime nativo do EmguCV para Linux (`Emgu.CV.runtime.ubuntu-x64`) são
compilados especificamente para Ubuntu 20.04 — não existe um pacote `linux-x64`
genérico (issue conhecida: [emgucv/emgucv#617](https://github.com/emgucv/emgucv/issues/617)).
Em Arch Linux essas libs nativas podem não carregar corretamente por incompatibilidade
de glibc/versões de sistema.

Esse risco foi **deliberadamente adiado**: não afeta o sub-projeto 1 (que não usa
EmguCV), mas precisa ser resolvido antes do sub-projeto 3 (calibração de câmera),
provavelmente via container Ubuntu ou build do OpenCV a partir do source.

## Decomposição do projeto completo

1. **App MAUI de captura + backend de ingestão** ← este documento
2. Calibração de câmera (intrínsecos) — aqui o risco do EmguCV/Linux precisa ser resolvido
3. Feature detection & matching (ORB/SIFT) entre frames extraídos
4. SfM de duas vistas — essential matrix, pose relativa, triangulação → primeira point cloud
5. SfM incremental multi-view — encadear todos os frames, bundle adjustment
6. Visualização/export da point cloud final (.ply, viewer simples)

Cada fase acima vira seu próprio ciclo spec → plano → implementação, na sequência.

## Decisões-chave desta fase

- **Captura por vídeo, não fotos**: usuário grava um vídeo girando ao redor do
  ambiente, em vez de tirar N fotos manualmente. Mais natural, menos fricção, upload
  de um único arquivo.
- **Plataforma: Android** (Tab S7). iOS foi descartado para esta fase porque build de
  app iOS via MAUI exige um Mac como build host (Xcode), inviável no ambiente Linux
  atual sem infra extra (CI com runner macOS, etc.).
- **Extração de frames via FFmpeg, não EmguCV**: mantém este sub-projeto livre do
  risco de lib nativa no Linux identificado acima. FFmpeg é pacote padrão do Arch
  (`pacman -S ffmpeg`), sem o problema de build específico de distro.
- **Sem service discovery**: usuário digita `IP:porta` do backend manualmente no app.
  Rede local (wifi), sem túnel/cloud relay. Decisão deliberada de simplicidade
  (YAGNI) — discovery automático (mDNS/Zeroconf) não é o foco do aprendizado e pode
  ser adicionado depois se incomodar.
- **Sem banco de dados**: sistema de arquivos é suficiente para o volume de dados
  (uma sessão de captura por vez, dezenas/centenas de frames).
- **Intervalo de extração fixo por enquanto**: 1 frame por segundo (`frameIntervalSeconds: 1`),
  hardcoded nesta fase. Não é o valor ideal para SfM (isso será ajustado na fase 3+
  com base na necessidade real de overlap entre frames), só evita bloquear esta fase
  numa decisão que pertence à fase de CV.

## Arquitetura

```
[Tab S7 - Cliffly.MobileApp]  --(HTTP multipart, vídeo)-->  [Cliffly - ASP.NET Core Web API]
                                                                      |
                                                                      v
                                                          captures/{sessionId}/
                                                            video.mp4
                                                            manifest.json
                                                            frames/001.jpg, 002.jpg, ...
                                                                      |
                                                                      v
                                                              FFmpeg (extração de frames)
```

Dois projetos na solution:

- `Cliffly.MobileApp` — novo projeto .NET MAUI, target Android.
- `Cliffly` — projeto existente, convertido de console app (`Microsoft.NET.Sdk`) para
  Web API mínima (`Microsoft.NET.Sdk.Web`). Mantém a referência ao Emgu.CV no
  `.csproj` (será usada a partir da fase 2), mas nenhum código desta fase chama a lib.

## Fluxo end-to-end

1. Backend sobe (`dotnet run` no projeto `Cliffly`) e imprime no console o IP local +
   porta (ex: `http://192.168.x.x:5000`).
2. Usuário abre o app no Tab S7, digita esse endereço nas configurações (persistido
   localmente via `Preferences` do MAUI).
3. Usuário toca "Gravar", grava o vídeo girando ao redor do ambiente via
   `MediaPicker.CaptureVideoAsync()`.
4. App mostra preview do vídeo gravado + botão "Enviar".
5. Ao tocar "Enviar": `POST /sessions` (cria sessão, recebe `sessionId`), seguido de
   `POST /sessions/{sessionId}/video` (multipart, upload do arquivo).
6. Backend salva o vídeo em `captures/{sessionId}/video.mp4`, dispara extração de
   frames via FFmpeg (processo assíncrono — `Process.Start` chamando o binário
   `ffmpeg`, ou wrapper como `FFMpegCore`), grava frames em
   `captures/{sessionId}/frames/`, atualiza `manifest.json` com status.
7. App consulta `GET /sessions/{sessionId}` para ver status (`processing` / `done` /
   `error`) e quantidade de frames extraídos.

## Modelo de dados (arquivos)

```
captures/
  {sessionId}/              # GUID
    video.mp4
    manifest.json           # { sessionId, createdAt, status, frameIntervalSeconds, frameCount, error? }
    frames/
      001.jpg
      002.jpg
      ...
```

## Tratamento de erros

- Vídeo permanece no armazenamento local do device até confirmação de upload
  bem-sucedido (HTTP 200) — permite retry manual sem perder a gravação.
- Backend valida que o arquivo recebido é um vídeo decodificável (`ffprobe`) antes de
  tentar extrair frames.
- Se a extração de frames falhar (ffmpeg retorna erro), `manifest.json` é marcado com
  `status: "error"` e a mensagem de erro — não derruba o backend nem trava outras
  sessões.
- Sessão existente não é sobrescrita: `POST /sessions/{sessionId}/video` retorna erro
  se já existe vídeo para aquela sessão.

## Teste

- Extração de frames via FFmpeg testável isoladamente com um vídeo de exemplo, sem
  precisar do app rodando.
- Endpoints do backend testáveis via curl/Postman antes do app MAUI existir.
- Fluxo end-to-end testado no emulador Android primeiro, depois no Tab S7 físico via
  wifi (mesma rede local).

## Fora de escopo (deliberadamente adiado)

- Qualquer processamento de visão computacional (calibração, feature matching,
  reconstrução 3D) — fases seguintes.
- Service discovery automático de backend na rede.
- Autenticação/segurança da API (rede local confiável, projeto de aprendizado pessoal).
- Suporte iOS.
- Qualidade/validação de overlap entre frames (vai importar na fase de SfM, não aqui).
