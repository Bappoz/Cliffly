# Validação da primeira versão

Data: 2026-10-08. Ambiente: Arch/Omarchy, .NET 10.0.302, Node 22.23.1,
Chromium Headless Shell 156 (Playwright). Este registro distingue testes
simulados de dispositivo físico e mede somente este ambiente.

## Resultados

| Verificação                                           | Resultado                                                                              |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Projeção, cor, profundidade, estabilidade e snapshots | 9 testes Node aprovados                                                                |
| API, manifests e processos FFmpeg                     | 10 testes .NET Release aprovados                                                       |
| Interface compilada no Chromium                       | 9 fluxos offline aprovados; teste de rede separado                                     |
| Inferência real de profundidade no browser            | Aprovada, sem respostas simuladas                                                      |
| Build Vite e publish .NET Release                     | Aprovados                                                                              |
| Revisão visual                                        | Desktop 1440 px e móvel 390 px, sem overflow horizontal                                |
| CI GitHub                                             | [Aprovado](https://github.com/Bappoz/Cliffly/actions/runs/37872192285), commit 7385270 |

A câmera usada no teste automatizado é o dispositivo simulado do Chromium.
Vídeos de teste são gerados por FFmpeg, sem usar gravações pessoais.
O pacote ASP.NET publicado também foi aberto no Chromium: demo renderizando
4.800 blocos, saúde 200, WASM 200 (`application/wasm`) e módulo 200 (`text/javascript`),
sem erros JavaScript.

## Inferência real

Foi executado Depth Anything V2 Small quantizado (q8) no worker WASM, com RGB
capturado da câmera simulada. O teste exporta os blocos e verifica variação real
nas coordenadas de profundidade. Cor e profundidade são do mesmo frame.

- Configuração inicial do processador (518 px): **23,43 s/quadro** observados.
- Configuração otimizada (224 px, preservando proporção e múltiplos de 14):
  **3,96 s/quadro** observados no teste posterior.
- São observações de execuções isoladas, não um benchmark de FPS garantido.
- WebGPU foi integrado com fallback de inicialização para WASM; GPU física ainda
  não foi avaliada. Em CPU, esta configuração não oferece profundidade a 30 FPS.
- O modo básico de blocos continua independente do modelo e limita processamento
  a 24 quadros/s; a interface mostra a taxa realmente processada.

A redução da entrada acelera inferência e pode perder contornos pequenos. A demo
usa profundidade sintética declarada, sem chamar o modelo.

## Problemas encontrados e corrigidos

- Manifest escrito diretamente podia ser lido pela metade: gravação temporária
  seguida de substituição atômica.
- Upload concorrente podia sobrescrever ou retornar 500 numa corrida de arquivos:
  exclusão por sessão em memória, com liberação em finally. Quatro cenários reais
  de concorrência cobertos nos testes .NET.
- Ativação da IA em desenvolvimento disparava otimização tardia e recarregava a
  página: dependência pré-otimizada no Vite e testes na compilação de produção.
- Ícone textual alterava o nome acessível de Exportar: nome explícito.
- Configuração de detalhe durante pedido de permissão invalidava a câmera:
  gerações de fonte e de processamento agora são independentes.
- Inferência/download têm limites de tempo, cancelamento de download e retorno ao
  modo básico. Worker descartado não pode aplicar resultados tardios.

## Limites ainda abertos

- Webcam física, incluindo iluminação e cor, exige validação pelo usuário.
- Nenhuma medição em metros, calibração de lente ou benchmark de reprojeção real.
- Não há pose, fusão multivista, reconstrução persistente ou faces ocultas.
- Não há segmentação/reconhecimento semântico de objetos nesta versão.
- Android/Bluetooth e importação em Minecraft ainda são issues planejadas.
- API destinada a uso local; não há autenticação nem quotas de armazenamento por usuário.
- Uma instância da API por diretório de capturas: exclusão de upload é local ao processo.
- O teste de rede da IA é excluído do CI offline e executado pelo comando separado.

Consulte [o plano](PLANO_PRODUTO.md) e [as issues](https://github.com/Bappoz/Cliffly/issues).
