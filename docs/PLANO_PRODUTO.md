# Cliffly: o ambiente ao vivo, em blocos

## Proposta

Transformar a imagem da webcam do notebook em uma cena de blocos navegável,
preservando enquadramento, cores e contornos. A interface deve funcionar sem
câmera usando uma demonstração e ser divertida de explorar, congelar e exportar.
O backend C# continua responsável pela ingestão de vídeos e por futuras etapas
de calibração, rastreamento e reconstrução.

Este plano substitui a prioridade anterior de criar um app MAUI de captura.
A autorização atual é implementar, testar e commitar em etapas.

## O que significa fidelidade

1. **Imagem em blocos:** cores e coordenadas da imagem são observadas. Todos os
   blocos estão em um plano; isso não é reconstrução tridimensional.
2. **Superfície com profundidade estimada:** Depth Anything V2 Small estima
   profundidade relativa. Projetamos cada pixel por um modelo pinhole e exibimos
   blocos em 3D. Não há medidas em metros nem geometria de superfícies ocultas.
3. **Reconstrução persistente:** exige calibração, pose da câmera, correspondência
   entre vistas e fusão. Não acumular frames sem pose: isso criaria objetos
   duplicados e posições incorretas. É uma fase distinta com critérios próprios.

Nenhum relevo será inventado a partir de brilho. A demonstração pode usar
profundidade sintética conhecida, identificada como demonstração.

## Arquitetura inicial

- ASP.NET Core / .NET 10: API existente, armazenamento por sessão, worker de
  extração supervisionado e hospedagem da interface compilada.
- Interface local com JavaScript, Vite e Three.js: getUserMedia, amostragem RGB,
  projeção e renderização por InstancedMesh. Sem React para esta interface pequena.
- Depth Anything V2 Small / Transformers.js em Web Worker, carregado só após
  ação explícita. WASM para compatibilidade; uma inferência por vez, sem fila de
  frames antigos. Cor e profundidade sempre pertencem ao mesmo frame.
- Modo básico funciona sem baixar modelo. Câmera processada no navegador;
  nenhum vídeo é enviado ao servidor automaticamente.
- Snapshot JSON versionado, PLY com posições e cores e PNG da visualização.
- Fontes intercambiáveis: demonstração, webcam e vídeo local; celular depois.

## Entregas e ordem dos chunks

| Issue | Entrega | Critério de aceite |
| --- | --- | --- |
| 01 | Plano, histórico público limpo e rastreabilidade | Issues criadas antes do código; capturas não publicadas |
| 02 | Ingestão confiável e testes do backend | Upload concorrente, arquivo vazio, erro FFmpeg, shutdown e manifests atômicos |
| 03 | Núcleo de projeção e snapshots | Testes de cor, orientação, profundidade, estabilidade e limites |
| 04 | Studio local com webcam e demo | Permissão explícita, parar libera câmera, controles acessíveis, WebGL e fallback |
| 05 | Profundidade estimada por IA | Worker, progresso, falhas recuperáveis, frame sincronizado, sem inferências sobrepostas |
| 06 | Congelar, explorar e exportar | Órbita, restauração JSON, export PLY/PNG e configurações persistidas |
| 07 | Verificação e documentação de uso | Testes automatizados, navegador com câmera simulada, build e CI |
| 08 | Calibração e benchmark de fidelidade | Intrínsecos reais, cena de referência, métricas de cor e reprojeção |
| 09 | Rastreamento de pose e reconstrução persistente | Testes multivista, recuperação após perder tracking, nenhuma fusão sem pose |
| 10 | Objetos e materiais | Segmentação avaliada e paleta Minecraft opcional; cores reais como padrão |
| 11 | Fonte móvel e pareamento Bluetooth | Prova de transporte no Android; controle/pareamento BLE, vídeo por canal validado |
| 12 | Exportação de mundo Minecraft | Formato escolhido e importado em uma instalação real; escala e licenças definidas |

Issues 01–07 constituem a primeira versão. Issues 08–12 são o roteiro para um
mundo reconstruído e a conexão móvel, sem dependência para usar a webcam hoje.

## Celular e Bluetooth

Web Bluetooth expõe serviços BLE/GATT; não oferece automaticamente um stream de
câmera de celular. A fase móvel deve validar app Android e protocolo de pareamento.
Planejar BLE para descoberta/controle e WebRTC/Wi-Fi (ou Bluetooth tethering
quando suportado) para vídeo. Não prometer vídeo por BLE antes de medir banda,
latência e suporte do aparelho.

## Validação

- Testes de unidade de matemática e serialização: Node test runner.
- Testes .NET para armazenamento, processos e ingestão.
- Playwright: demonstração, webcam simulada, falha de permissão, congelamento,
  importação/exportação, teclado e tamanho de tela móvel.
- Teste real do modelo, separado da suíte offline; nenhuma resposta fictícia
  apresentada como inferência verificada.
- Build em modo Release, frontend sem CDN em runtime, CI reproduzível.
- Teste físico da webcam e Bluetooth depende dos dispositivos e permanece
  explicitamente pendente se não for possível executá-lo neste ambiente.

## Referências técnicas

- [getUserMedia e contexto seguro](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [Three.js InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html)
- [Pipeline de profundidade](https://huggingface.co/docs/transformers.js/api/pipelines#module_pipelines.DepthEstimationPipeline)
- [Modelo e licença](https://huggingface.co/onnx-community/depth-anything-v2-small)
- [Web Bluetooth](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API)
