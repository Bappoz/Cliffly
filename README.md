# Cliffly

**Grave um ambiente, salve o vídeo, reconstrua várias vistas e explore o mundo 3D em blocos.**

A captura guiada gera uma prévia incremental enquanto você grava, para orientar novas vistas. Depois, a análise multivista da gravação completa refina o mundo. As posições vêm de correspondências entre frames e triangulação; o modelo permanece salvo e pode ser explorado independentemente do vídeo.

## Executar localmente

Requisitos: Node.js 22.12+, .NET SDK 10, Python 3.11+ e FFmpeg/ffprobe no PATH. O motor funciona em CPU; não precisa de GPU ou API paga.

```bash
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r reconstruction/requirements.txt
npm run build
dotnet run --project Cliffly
```

Abra **http://localhost:5000**. No Windows, use `.venv\Scripts\python.exe` nos comandos Python. Se preferir uv: `uv venv .venv` e `uv pip install --python .venv/bin/python -r reconstruction/requirements.txt`.

Em máquinas com libvips que provoquem compilação do Sharp, use `SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm ci`.

Para editar a interface, mantenha a API rodando e execute `npm run dev` em outro terminal. Abra http://localhost:5173; o Vite encaminha `/sessions` e `/health` à API.

## Como usar

1. Mantenha **Prévia 3D durante a gravação** ativada e clique em **Gravar com webcam**. A gravação começa imediatamente; amostras da câmera são enviadas ao servidor local.
2. Desloque a câmera devagar. Depois de obter vistas com baseline suficiente, uma prévia em blocos cresce ao lado. A seta indica a pose estimada da câmera.
3. Ative **Cobertura**: amarelo indica poucas vistas/ângulos; verde indica evidência de várias vistas. Observe as regiões amarelas de outra posição. Espaços vazios são desconhecidos, e não uma porcentagem de um ambiente completo.
4. Use a dica na câmera, com a região sugerida destacada. Se perder o rastreamento, volte lentamente a uma região já vista. Imagem parada, desfoque e pouca textura têm dicas específicas.
5. Pare, reveja e use **Baixar gravação** para guardar uma cópia. A prévia fica preservada. Clique em **Refinar e gerar mundo** para analisar a gravação completa com o motor multivista.
6. Explore em órbita ou **Entrar no mundo**. WASD move, E/espaço sobe, Q desce, Shift acelera; clique na cena para olhar com o mouse, Esc libera. Setas também orientam e Home volta à vista inicial. Atualizações da prévia preservam sua vista.
7. Baixe o mundo JSON ou os pontos PLY. **Abrir mundo** reabre sem reprocessar. A URL da sessão e o histórico local retomam capturas salvas após recarregar.

Também é possível desativar a prévia e somente gravar, ou importar um vídeo. Se a prévia ficar indisponível, o vídeo continua sendo gravado e pode ser processado ao terminar.

O botão **Explorar exemplo reconstruído** abre uma sala sintética gerada por ray casting e reconstruída a partir de 18 vistas. Ela é identificada como exemplo sintético, não como filmagem real.

## Limites da captura guiada

A prévia é **experimental**, usa intrínsecos aproximados e pode ter deriva, buracos e atraso. Não tem fechamento global de trajetórias ou ajuste contínuo de feixes. O processamento final permanece o caminho para refinar a geometria. A avaliação da câmera física e a calibração continuam nas issues #8–#9.

O motor mantém a mesma origem, escala relativa e grade ao longo da captura. Usa ORB, inicialização por geometria epipolar, PnP com RANSAC, triangulação e estéreo retificado. A cobertura considera IDs de vistas distintos e diversidade angular (ao menos três vistas e oito graus para verde); não estima precisão métrica nem conhece o espaço escondido.

O navegador envia uma amostra por vez, aproximadamente uma por segundo, reduzindo a frequência se o motor demorar. Não há promessa de 30 FPS. Densificação ocorre em vistas com deslocamento útil; repetir a mesma imagem não aumenta a cobertura. Limites: uma prévia ativa, JPEG de até 1 MiB e 1 milhão de pixels, 180 amostras, 80 vistas úteis e 30 mil voxels. Inatividade de 30 segundos ou duração de 3 minutos encerra o worker.

## Capturar bem

Filme objetos parados e com textura, com iluminação estável. Desloque a câmera para os lados ou ao redor deles, mantendo grande sobreposição entre vistas. Apenas girar no mesmo ponto não fornece baseline adequado para profundidade. Evite zoom, movimentos bruscos, reflexos e desfoque. Comece com 10–60 segundos de uma parte do ambiente.

Gravação da webcam: até 120 segundos, sem áudio. Upload: até 128 MiB. Extração: primeiros 120 segundos, uma vista por segundo; o motor seleciona até 60 vistas e reduz imagens para até 800 pixels. Limite de 120 mil blocos com redução automática da resolução espacial.

## O que o resultado representa

- SfM estima intrínsecos, poses e pontos triangulados, com ajuste de feixes.
- Estéreo retificado em CPU estima superfícies, verifica consistência esquerda/direita e filtra pontos fora dos limites da geometria observada.
- A fusão ocupa uma grade uniforme e calcula cores médias das observações.
- As superfícies não observadas ficam vazias. Objetos não são classificados semanticamente nesta versão.
- A escala é relativa: uma câmera monocular não fornece metros sem referência conhecida.
- A fidelidade de filmagens reais ainda precisa de avaliação. Paredes lisas, vidro, espelhos e movimento podem gerar buracos, ruído ou falha. O sistema informa falhas e permite tentar novamente.
- A navegação livre não tem colisões. O JSON é um mundo do visualizador Cliffly; exportação para um arquivo do jogo Minecraft é uma etapa futura (#12).

O laboratório anterior de efeitos por frame está em `/lab.html`. Ele não é o motor de reconstrução do produto.

## Arquitetura e dados

`MediaRecorder/upload → ASP.NET → FFmpeg → PyCOLMAP (SfM CPU) → OpenCV (StereoSGBM) → fusão → world.json → Three.js`.

A API segue em C#. O motor Python é um processo supervisionado, com fila limitada, limite de 20 minutos, progresso persistente, proteção contra jobs duplicados e recuperação após reinício. Documentação técnica: [PyCOLMAP](https://colmap.github.io/pycolmap/pycolmap.html), [calibração e reconstrução OpenCV](https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html).

A prévia fica em `Cliffly/captures/scans/{guid}/`, com estado, vistas úteis e último mundo. Cada captura final fica em `Cliffly/captures/{guid}/`: vídeo, manifesto, frames, banco de correspondências, modelo SfM, progresso e mundo. A pasta é ignorada pelo Git e excluída do publish. Nenhuma filmagem pessoal é publicada.

Configuração opcional por variáveis de ambiente:

- `CaptureRoot`: diretório de capturas.
- `Reconstruction__Python`: caminho do Python com as dependências instaladas.
- `Reconstruction__Script`: caminho de `reconstruct.py`.
- `Reconstruction__GuideScript`: caminho de `guide.py`.
- `GuidedScan__IdleSeconds`: inatividade máxima da prévia (2–120 segundos, padrão 30).

No publish, os scripts e requirements acompanham a aplicação. Instale as dependências Python no ambiente de execução e configure `Reconstruction__Python`.

## API

| Endpoint                             | Função                                                 |
| ------------------------------------ | ------------------------------------------------------ |
| `POST /scans`                        | Inicia a prévia incremental                            |
| `POST /scans/{id}/frames`            | Corpo JPEG, `Content-Type: image/jpeg`                 |
| `GET /scans/{id}`                    | Tracking, dica, pose e revisão                         |
| `GET /scans/{id}/world`              | Último snapshot, com cobertura por voxel               |
| `POST /scans/{id}/stop`              | Encerra o worker e preserva o modelo                   |
| `GET /health`                        | Saúde e disponibilidade do motor                       |
| `POST /sessions`                     | Cria uma sessão                                        |
| `POST /sessions/{id}/video`          | Upload multipart, campo `video`; extrai frames         |
| `GET /sessions/{id}`                 | Estado da captura e progresso da reconstrução          |
| `POST /sessions/{id}/reconstruction` | Agenda reconstrução quando os frames estiverem prontos |
| `GET /sessions/{id}/world`           | Baixa o mundo somente após sucesso                     |
| `GET /sessions/{id}/video`           | Baixa a gravação salva após extração                   |

## Testar

```bash
npm run format:check
npm test
dotnet test Cliffly.sln -c Release
.venv/bin/python -m pytest reconstruction/tests -q
CLIFFLY_SFM_TEST=1 .venv/bin/python -m pytest reconstruction/tests -q
npx playwright install chromium
npm run test:e2e
```

O teste SfM completo gera uma cena 3D e usa o motor real em CPU. Para testar vídeo, API e navegador juntos, com a API rodando:

```bash
.venv/bin/python reconstruction/synthetic.py /tmp/cliffly-multiview/frames
ffmpeg -y -framerate 1 -i /tmp/cliffly-multiview/frames/%04d.jpg -c:v libx264 -crf 18 -pix_fmt yuv420p /tmp/cliffly-multiview/room.mp4
CLIFFLY_REAL_RECON=1 npx playwright test web/e2e/capture.spec.js -g 'real saved video'
```

Para testar a captura guiada pelo dispositivo simulado do Chromium, com a API rodando:

```bash
ffmpeg -y -v error -framerate 1 -i /tmp/cliffly-multiview/frames/%04d.jpg -vf fps=30 -pix_fmt yuv420p -f yuv4mpegpipe /tmp/cliffly-multiview/camera.y4m
CLIFFLY_REAL_GUIDE=1 npx playwright test web/e2e/guided.spec.js
```

`CLIFFLY_TEST_GUIDE_VIDEO` permite escolher um arquivo Y4M para a câmera simulada. `CLIFFLY_TEST_VIDEO` permite escolher outro vídeo de teste. A validação com webcam automatizada usa uma câmera simulada; não substitui a avaliação da câmera física.

Plano e issues: [PLANO_PRODUTO.md](docs/PLANO_PRODUTO.md), [issues públicas](https://github.com/Bappoz/Cliffly/issues). Evidências: [VALIDACAO.md](docs/VALIDACAO.md).
