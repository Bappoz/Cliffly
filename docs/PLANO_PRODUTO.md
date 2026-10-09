# Cliffly — vídeo para um mundo navegável

## Proposta corrigida

Gravar ou importar um vídeo, salvar a captura, analisar múltiplos frames e reconstruir um ambiente 3D persistente em blocos. As posições e cores vêm das observações do vídeo. O usuário navega pelo resultado depois do processamento.

O protótipo anterior transformava um frame em uma superfície de cubos. Ele permanece como laboratório, mas não atende ao produto principal.

## Fluxo

1. Orientar a captura: ambiente parado, boa luz, movimento lateral lento e sobreposição entre vistas. Girar a câmera sem deslocá-la não fornece profundidade suficiente.
2. Gravar pela webcam ou importar vídeo. Rever e baixar a gravação antes de processar.
3. Salvar a sessão e extrair frames com FFmpeg.
4. Estimar intrínsecos, correspondências, poses e pontos 3D com Structure from Motion (PyCOLMAP, CPU).
5. Retificar pares de vistas, estimar disparidades com OpenCV e fusionar observações em uma grade de voxels com cores.
6. Salvar mundo, trajetória da câmera e métricas; explorar em órbita ou navegação livre.
7. Exportar/reabrir o mundo sem reprocessar o vídeo.

## Limites assumidos

- A escala monocular é relativa até existir calibração com uma medida conhecida.
- Não inventar superfícies escondidas, objetos ou geometria a partir do brilho.
- Pouca textura, reflexos, movimento e desfoque podem impedir a reconstrução. Informar a falha e sugerir nova captura.
- O resultado é uma reconstrução de superfícies observadas em blocos; não é um mapa semântico completo nem um arquivo do jogo Minecraft.
- O processamento é posterior à gravação, local no servidor, e pode demorar minutos. Nenhuma API paga ou GPU é obrigatória.

## Chunks e issues

1. #13: motor multivista em CPU, fusão e testes geométricos.
2. #14: jobs persistentes, progresso, recuperação e downloads na API C#.
3. #15: captura/importação, revisão e processamento posterior.
4. #16: mundo persistente, órbita, navegação livre e exportação.
5. #17: validação integrada com vídeo sintético, documentação e CI.

Cada chunk recebe seu próprio commit com referência à issue. As issues #8–#12 seguem como evoluções: calibração, robustez, semântica, celular e exportação para o jogo.

## Arquitetura

Browser (MediaRecorder / upload / Three.js) → API ASP.NET → FFmpeg → worker Python (PyCOLMAP + OpenCV) → world.json + modelo SfM → browser.

A API continua em C#. A separação do worker permite substituir o motor de visão sem alterar o fluxo do produto.
