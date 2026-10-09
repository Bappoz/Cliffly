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
- A reconstrução final é posterior à gravação e pode demorar minutos. A captura guiada adiciona uma prévia incremental durante a gravação. Ambos os motores rodam localmente, sem API paga ou GPU obrigatória.

## Chunks e issues

1. #13: motor multivista em CPU, fusão e testes geométricos.
2. #14: jobs persistentes, progresso, recuperação e downloads na API C#.
3. #15: captura/importação, revisão e processamento posterior.
4. #16: mundo persistente, órbita, navegação livre e exportação.
5. #17: validação integrada com vídeo sintético, documentação e CI.

As issues #13–#17 foram implementadas, testadas e encerradas. Cada chunk recebeu seu próprio commit com referência à issue. As issues #8–#12 seguem como evoluções: calibração, robustez, semântica, celular e exportação para o jogo.

## Arquitetura

Browser (MediaRecorder / upload / Three.js) → API ASP.NET → FFmpeg → worker Python (PyCOLMAP + OpenCV) → world.json + modelo SfM → browser.

A API continua em C#. A separação do worker permite substituir o motor de visão sem alterar o fluxo do produto.

## Captura guiada — nova evolução (#18–#22)

Enquanto o vídeo é gravado, enviar amostras reduzidas ao motor incremental. Estimar pose, triangular e fusionar superfícies observadas em coordenadas persistentes. Atualizar uma prévia em blocos e destacar pouca diversidade de vistas em amarelo e boa evidência em verde. Espaços vazios permanecem desconhecidos.

A prévia usa OpenCV (ORB, geometria epipolar, PnP e estéreo) e intrínsecos aproximados. Não é um sistema SLAM completo: não tem fechamento de trajetórias nem ajuste global contínuo. Serve para orientar a captura; o motor multivista posterior continua refinando o mundo final.

Transportar um frame por vez, sem acumular fila no navegador. Densificar apenas keyframes com deslocamento útil. Manter o vídeo completo independente da prévia e liberar o worker ao terminar ou após inatividade. Medir latência antes de prometer taxas de atualização.

Chunks: #18 motor incremental; #19 cobertura/orientação; #20 API/lifecycle; #21 experiência guiada; #22 testes integrados e documentação.
