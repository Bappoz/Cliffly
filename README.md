# Cliffly

**Grave um ambiente, salve o vídeo, reconstrua várias vistas e explore o mundo 3D em blocos.**

O produto principal agora faz análise posterior da gravação. As posições vêm de correspondências entre frames e triangulação multivista. O mundo é persistente e não muda com a reprodução do vídeo.

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

1. Clique em **Gravar com webcam**, mova a câmera lentamente e pare a gravação; ou importe um vídeo.
2. Reveja e use **Baixar gravação** para guardar uma cópia local.
3. Clique em **Salvar e gerar mundo**. O vídeo é salvo na sessão e o processamento acontece no servidor local.
4. Acompanhe extração dos frames, correspondências, poses, estéreo e fusão. O processo pode levar minutos.
5. Explore em órbita ou clique em **Entrar no mundo**. WASD move, E/espaço sobe, Q desce, Shift acelera; clique na cena para olhar com o mouse, Esc libera. Setas também orientam e Home volta à vista inicial.
6. Baixe o mundo JSON ou os pontos PLY. **Abrir mundo** reabre um resultado sem processar novamente. A URL da sessão e o histórico local permitem retomar capturas após recarregar.

O botão **Explorar exemplo reconstruído** abre uma sala sintética gerada por ray casting e reconstruída pelo mesmo motor a partir de 18 vistas. Ela é identificada como exemplo sintético, não como filmagem real.

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

Cada captura fica em `Cliffly/captures/{guid}/`: vídeo, manifesto, frames, banco de correspondências, modelo SfM, progresso e mundo. A pasta é ignorada pelo Git e excluída do publish. Nenhuma filmagem pessoal é publicada.

Configuração opcional por variáveis de ambiente:

- `CaptureRoot`: diretório de capturas.
- `Reconstruction__Python`: caminho do Python com as dependências instaladas.
- `Reconstruction__Script`: caminho de `reconstruct.py`.

No publish, os scripts e requirements acompanham a aplicação. Instale as dependências Python no ambiente de execução e configure `Reconstruction__Python`.

## API

| Endpoint                             | Função                                                 |
| ------------------------------------ | ------------------------------------------------------ |
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

`CLIFFLY_TEST_VIDEO` permite escolher outro vídeo de teste. A validação com webcam automatizada usa uma câmera simulada; não substitui a avaliação da câmera física.

Plano e issues: [PLANO_PRODUTO.md](docs/PLANO_PRODUTO.md), [issues públicas](https://github.com/Bappoz/Cliffly/issues). Evidências: [VALIDACAO.md](docs/VALIDACAO.md).
