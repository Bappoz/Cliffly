# Cliffly

Seu ambiente em blocos, a partir da webcam do notebook. Um Studio local para
experimentar cores, congelar instantes e explorar uma superfície 3D.

## Experimente

Requisitos: Node.js 22.12+ e npm. Para a API: .NET SDK 10 e FFmpeg no PATH.

```bash
npm ci
npm run dev
```

Abra **http://localhost:5173**. A demonstração funciona sem câmera. Clique em
**Usar webcam** e permita o acesso. Nenhum vídeo é enviado ao backend automaticamente.

Em sistemas com libvips instalado que façam o Sharp tentar compilar do zero:

```bash
SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm ci
```

## O que já funciona

- Webcam selecionável, vídeo local e uma demonstração com profundidade sintética.
- Superfície de blocos com cores e enquadramento da imagem.
- Profundidade relativa opcional com Depth Anything V2 Small no navegador.
- Órbita, zoom, congelamento, comparação sem iluminação artística e paleta opcional.
- Exportação JSON reimportável, PLY (nuvem de pontos com cor e tamanho de bloco) e PNG.
- Qualidade ajustável e configurações locais persistidas; frames não são salvos automaticamente.
- Interface em português, teclado, layout móvel e preferência por movimento reduzido.
- API C# de sessões e extração de frames supervisionada com FFmpeg.

**Fidelidade:** o modo básico é plano. A IA estima profundidade relativa, sem metros,
sem superfícies escondidas e sem rastrear a pose. Mover a câmera atualiza a superfície
vista; ainda não constrói um mundo persistente de todo o cômodo. A paleta de blocos é
artística; use cores originais + Comparar cores para preservar RGB sem iluminação.
Não há ainda identificação semântica de objetos ou exportação de mundo Minecraft.

## Controles

Arraste a cena para girar e role para aproximar. **Vista original** restaura a
projeção da captura. **Congelar cena** permite explorar um instante; a câmera fica
ativa até **Desligar**. **Espaço** congela quando o foco não está em um controle.
No canvas: setas giram, `+`/`−` aproximam/afastam e `Home` restaura a vista.

A IA baixa pesos na primeira ativação e os processa em um Web Worker, com WebGPU quando disponível e WASM como alternativa. O download
pode ser cancelado e falhas devolvem o modo básico. A cor e o mapa de profundidade
pertencem ao mesmo frame. A velocidade real depende do hardware; o Studio mostra
quadros/s processados, backend e tempo de inferência. A entrada da IA é reduzida
para 224 pixels (preservando proporção e múltiplos de 14), trocando detalhe fino por
menor latência; a resolução de blocos é um controle independente. Não promete 30 FPS de IA em CPU.
Internet é necessária para baixar o modelo; a reutilização offline depende do cache
do navegador. O runtime ONNX é servido localmente. Não há API de inferência paga.

## Interface compilada + API

```bash
npm ci
npm run build
dotnet run --project Cliffly
```

Abra **http://localhost:5000**. A API hospeda os arquivos compilados em `wwwroot`.
Não é preciso executar o servidor Vite nesse modo. O build do frontend deve acontecer
antes de `dotnet publish`.

```bash
dotnet publish Cliffly -c Release -o /tmp/cliffly-publish
```

Endpoints:

| Método | Rota                   | Uso                                    |
| ------ | ---------------------- | -------------------------------------- |
| GET    | `/health`              | Estado do servidor                     |
| POST   | `/sessions`            | Cria uma sessão, retorna 201           |
| POST   | `/sessions/{id}/video` | Multipart, campo `video`; retorna 202  |
| GET    | `/sessions/{id}`       | Consulta pending/processing/done/error |

Upload limitado a 128 MiB. Fila limitada a oito sessões aguardando processamento.
FFmpeg extrai um frame/s dos primeiros 120 s, com dimensão máxima de 1280×720.
Arquivo vazio retorna 400; upload duplicado/concorrente retorna 409; fila cheia 503.
Um arquivo com áudio sem vídeo é rejeitado no processamento. Capturas ficam em
`Cliffly/captures/{id}`; `CaptureRoot` permite configurar outro diretório.

Por padrão o servidor escuta somente localhost. Para testes na rede:

```bash
dotnet run --project Cliffly --urls http://0.0.0.0:5000
```

Acesso à câmera pelo navegador exige **localhost ou HTTPS**; abrir um IP de rede em
HTTP não habilita getUserMedia. A API de ingestão local ainda não tem autenticação.

## Testes

```bash
npm test
dotnet test Cliffly.sln
npx playwright install chromium
npm run test:e2e
```

A suíte de navegador usa câmera simulada, não sua webcam física. O teste do modelo
real é separado, baixa os pesos e executa inferência no worker do navegador:

```bash
npm run test:depth
```

O CI executa matemática/serialização, backend, build e fluxos de navegador sem baixar
pesos. FFmpeg deve estar instalado para os testes .NET que geram e decodificam vídeo.
Consulte [o registro de validação](docs/VALIDACAO.md) para resultados e limites.

## Organização e próximos passos

[Plano completo](docs/PLANO_PRODUTO.md) · [Issues](https://github.com/Bappoz/Cliffly/issues)

A primeira versão cobre as issues 1–7. As próximas etapas são calibração da câmera,
rastreamento de pose e fusão multivista, segmentação de objetos, fonte Android e
exportação de mundo Minecraft. Bluetooth será validado com aparelho real: BLE/GATT
serve para pareamento/controle; o transporte de vídeo precisa de banda e protocolo
próprios, possivelmente Wi-Fi/WebRTC ou tethering.

```text
Cliffly/            API .NET, worker FFmpeg e hospedagem do Studio
Cliffly.Tests/      Testes xUnit e integração ASP.NET
web/src/            Captura, projeção, renderização e worker de profundidade
web/tests/          Testes de matemática e snapshots
web/e2e/            Fluxos de navegador com Playwright
scripts/            Preparação do ONNX e verificação real do modelo
docs/               Plano, critérios e registro de validação
```

Os documentos em `docs/superpowers/` descrevem o plano anterior orientado a MAUI;
o plano atual é `docs/PLANO_PRODUTO.md`. O histórico antigo e as gravações permanecem
na branch `master` local; o histórico público `main` começou sem mídia pessoal.

## Dependências e referências

Three.js para renderização e Transformers.js/ONNX Runtime para inferência. O modelo
é [onnx-community/depth-anything-v2-small](https://huggingface.co/onnx-community/depth-anything-v2-small),
conversão do [Depth Anything V2 Small](https://github.com/DepthAnything/Depth-Anything-V2).
Consulte as licenças das bibliotecas e do modelo antes de redistribuir pesos.

A projeção usa um FOV vertical aproximado de 55° e unidades relativas. Calibração
real está na [issue 8](https://github.com/Bappoz/Cliffly/issues/8), reconstrução
persistente na [issue 9](https://github.com/Bappoz/Cliffly/issues/9) e celular/Bluetooth
na [issue 11](https://github.com/Bappoz/Cliffly/issues/11).
