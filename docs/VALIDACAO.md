# Validação da captura guiada

Data: 2026-10-09. A prévia incremental é experimental e foi verificada separadamente do refinamento offline.

## Geometria e cobertura

- Cena sintética com deslocamento conhecido, processada incrementalmente com ORB, inicialização epipolar, PnP, triangulação e estéreo em CPU. O motor não recebe poses prontas.
- Câmera parada e rotação pura não inicializam um mundo. Desfoque/pouca textura e uma imagem sem correspondências não alteram o último modelo válido.
- Repetir o mesmo frame não aumenta revisões ou cobertura. A evidência exige vistas distintas e diversidade angular; espaços desconhecidos não recebem voxels artificiais.
- Limites de blocos preservam a mesma grade e escala ao longo do scan.

## Integração durante a gravação

O Chromium usou uma câmera simulada alimentada por vídeo Y4M de uma sala sintética em movimento. O navegador enviou JPEGs reais à API, que supervisionou o worker Python real. A gravação completa continuou em paralelo. Ao parar, o processo foi encerrado e o mundo permaneceu disponível.

Nesse experimento: 11 amostras, 9 vistas úteis, 3.441 blocos observados e 1.392 com evidência de várias vistas/ângulos. A última amostra levou 1.192 ms no worker. No protótipo direto, acompanhamento de pose ficou perto de 100 ms e densificação entre 500 e 800 ms. São medidas deste ambiente, não uma garantia de taxa para outros notebooks.

Os seis testes específicos do navegador passaram, incluindo modelo crescente sem reset da navegação, alternância de cores/cobertura, perda de tracking, falha da prévia sem perder a gravação, gravação sem prévia e encerramento de um worker que iniciou depois do usuário parar.

API: 22 testes C# aprovados, incluindo concorrência limitada, JPEG vazio/tamanho excessivo, worker inativo, reinício e parada durante processamento. JavaScript: 14 testes. Python: 11 aprovados e um teste SfM demorado omitido nesta execução; a reconstrução completa é coberta também pelo teste integrado de vídeo.

## Limites

A câmera usada é simulada; a cena é sintética. A precisão da câmera física, calibração e deriva em trajetórias longas ainda precisam ser medidas. Verde indica diversidade de observações, não precisão métrica ou conclusão de todo o ambiente. A prévia não implementa fechamento global de trajetórias ou ajuste contínuo de feixes. O motor final continua refinando a gravação.

---

# Validação do fluxo vídeo → mundo 3D

Data: 2026-10-08. Linux, Python 3.11, PyCOLMAP 4.2.1, OpenCV 4.13,
.NET 10.0.302, Node 22.23.1 e Chromium Headless Shell 156.

## Evidência geométrica

A sala sintética é gerada por ray casting de paredes e três objetos, com texturas determinísticas e 18 câmeras que se deslocam. Os testes não fornecem poses ao motor. PyCOLMAP estima as câmeras, triangula e faz ajuste de feixes; OpenCV retifica pares estimados e gera pontos por disparidade. A fusão usa as cores observadas.

O primeiro experimento registrou 18/18 vistas, 5.111 pontos esparsos, 336.679 pontos densos e 55.941 blocos em 43 segundos. A revisão identificou que limites derivados apenas dos pontos esparsos podiam cortar objetos próximos. Os limites passaram a incluir a trajetória; o teste completo agora exige também superfícies em primeiro plano.

Depois da correção, o teste direto registrou 18 vistas, 434.778 pontos densos e 62.236 blocos em 65,8 segundos (execução concorrente com testes de navegador). A superfície mais próxima ficou em z = -8,04 na escala normalizada, dentro do limite exigido pelo teste de primeiro plano.

No teste integrado com vídeo MP4, FFmpeg, API e navegador reais: 18 frames registrados, 602.325 pontos densos e 79.196 blocos, com 87,5 segundos de processamento. O mundo foi baixado e reaberto após recarregar a página. As métricas variam com compressão e correspondências.

O teste estéreo separado usa baseline, focal e disparidade conhecidos e verifica profundidade numérica. Outros testes cobrem cores médias, limite de voxels, coordenadas não finitas e falha sem frames suficientes.

## Testes

- JavaScript: 13 testes de projeção e validação/exportação de mundos.
- C#: 16 testes, incluindo FFmpeg real, uploads concorrentes, jobs duplicados, progresso, falha/retry e recuperação após reinício.
- Python: 6 testes incluindo execução explícita de SfM e estéreo reais em CPU.
- Navegador: 19 testes aprovados; apenas a inferência de profundidade do laboratório é omitida nesta execução. Inclui teste real de vídeo/API/motor em CPU e captura/revisão/download, liberação da webcam, upload/progresso/retomada, navegação/exportação, formatos inválidos, indisponibilidade do motor e layout móvel. Fluxos simulados de API são separados do teste com vídeo/API/motor reais.

## CI e revisão final

[CI aprovado](https://github.com/Bappoz/Cliffly/actions/runs/37875189850) no commit `be7ba45`: formatação, 13 testes JavaScript, 16 testes C#, build/publish, testes Python e 19 testes de navegador (incluindo vídeo/API/motor reais). O teste de inferência do laboratório é separado e ficou omitido.

Após os ajustes de revisão da gravação salva e alocação do visualizador, os nove testes da interface principal foram repetidos localmente: todos passaram. O exemplo foi reduzido para 4.950 blocos para facilitar a exploração em máquinas mais lentas.

Um vídeo existente de cinco segundos não forneceu um par inicial válido de câmeras. O motor registrou uma falha explícita e não escreveu um mundo; esse resultado não comprova fidelidade em filmagens reais.

## Limites da evidência

A cena geométrica é sintética. A webcam automatizada é a câmera simulada do Chromium. Ainda não foi avaliada a fidelidade de uma filmagem real de notebook, com calibração e medidas de referência. Não se afirma precisão métrica, classificação semântica ou reconstrução de superfícies ocultas.

# Histórico: validação do laboratório por frame

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
