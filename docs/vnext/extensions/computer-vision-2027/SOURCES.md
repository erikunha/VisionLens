# Evidence register — primary references and license notes

**Pesquisado em:** 2026-11-15. Quando disponíveis, foram priorizadas páginas oficiais de projetos, repositórios upstream, model cards e termos de licença. As descrições abaixo são **evidência externa**, não prova de desempenho em VisionLens. Links apontam para fontes públicas que podem sofrer alterações. URLs não autorizam download ou redistribuição.

### S01

**PyTorch / Transfer Learning**
- [Official PyTorch tutorial: Transfer Learning for Computer Vision](https://docs.pytorch.org/tutorials/beginner/transfer_learning_tutorial.html)
- **Suporta:** frozen feature extractor e fine-tuning do backbone; boa referência para Lab 09.

### S02

**Oxford-IIIT Pet**
- [University of Oxford — Visual Geometry Group, Oxford-IIIT Pets](https://www.robots.ox.ac.uk/~vgg/data/pets/)
- **Suporta:** 37 classes e labels de raça, head ROI, trimap; licença exibida como CC BY-SA 4.0 para pesquisa/comércio, copyright das imagens mantido por titulares originais. Conferir direitos e atribuição antes de distribuir imagens.

### S03

**SigLIP2**
- [Hugging Face — SigLIP 2 introduction](https://huggingface.co/blog/siglip2)
- [Google checkpoint — siglip2-base-patch16-224](https://huggingface.co/google/siglip2-base-patch16-224)
- **Suporta:** embeddings cross-modal, zero-shot, transfer; card desse checkpoint declara Apache-2.0. Hardware/memória e qualidade ainda precisam ser medidos no projeto.

### S04

**RT-DETR**
- [Official RT-DETR repository](https://github.com/lyuwenyu/RT-DETR)
- **Suporta:** detector transformer PyTorch/Paddle; código sob Apache-2.0 no repositório. Model weights e datasets associados exigem revisão individual.

### S05

**Ultralytics YOLO26 / license**
- [Ultralytics — licensing](https://www.ultralytics.com/license)
- [YOLO26 model card](https://huggingface.co/Ultralytics/YOLO26)
- **Suporta:** dual license AGPL-3.0/Enterprise, inclusive condições declaradas para pesos/modelos derivados. Não inferir que todo uso comercial é proibido; avaliar as obrigações específicas ou obter licença apropriada.

### S06

**ByteTrack, BoT-SORT and trackers**
- [Ultralytics official tracking documentation](https://docs.ultralytics.com/modes/track)
- **Suporta:** tracking para vídeo, ByteTrack/BoT-SORT e opções adicionais atuais; IDs de tracking temporários. Os números de qualidade/custo do fornecedor não substituem testes VisionLens.

### S07

**PaddleOCR / PP-OCRv6 (2026)**
- [PaddleOCR official GitHub](https://github.com/PaddlePaddle/PaddleOCR)
- [PaddleOCR release history](https://github.com/PaddlePaddle/PaddleOCR/releases)
- **Suporta:** projeto Apache-2.0, anúncio PP-OCRv6 em 11/06/2026, famílias OCR/Document AI. Atribuições de superioridade são claims de upstream, requerem eval independente.

### S08

**UFPR-ALPR (Brasil)**
- [UFPR — dataset source](https://web.inf.ufpr.br/vri/databases/ufpr-alpr/)
- [UFPR — license agreement](https://web.inf.ufpr.br/vri/databases/ufpr-alpr/license-agreement/)
- **Suporta:** 4.500 imagens/150 veículos; acesso de pesquisa acadêmica, não comercial, sem redistribuição/modificação/comercialização sem permissão expressa.

### S09

**SHWD / Safety Helmet Wearing Dataset**
- [Original repository](https://github.com/njvisionpower/Safety-Helmet-Wearing-Dataset)
- **Suporta:** boxes de capacete/cabeça; repositório com licença MIT, mas parte das imagens vem de busca Google/Baidu e dataset antecedente. **Não** atribuir MIT à propriedade intelectual de cada foto por dedução.

### S10

**P3M-10K / Portrait Matting**
- [Original P3M research repository](https://github.com/JizhiziLi/P3M)
- [Dataset information/converted mirror](https://huggingface.co/datasets/nobg/P3M-10K)
- **Suporta:** 9.421 imagens de treino com blur de faces e alpha mattes, testes P3M-500-P / NP, acordo do autor sob MIT, cuidados com direitos de imagem. O dataset agreement original está vinculado pelo repo.

### S11

**DIS5K terms of use — IMPORTANT LICENSE CONFLICT**
- [Original DIS author repository](https://github.com/xuebinqin/DIS)
- [Public HF mirror and its disputed metadata](https://huggingface.co/datasets/nobg/DIS5K)
- [Source terms-of-use PDF (inspected)](https://huggingface.co/api/resolve-cache/datasets/nobg/DIS5K/05a5a76e46779a2c442f88bbc236eaa64a1283d2/DIS5K%20Dataset%20Terms%20of%20Use.pdf?download=true&etag=%2247853c11456f2b737e4fba83b104d77044075f17%22)
- **Suporta:** 5.470 imagens, dataset original restrito a pesquisa/educação não comercial, distribuição vedada. O mirror apresenta tag Apache-2.0 conflitante; tratar como `LICENSE_CONFLICT` e bloquear redistribuição/uso comercial enquanto não resolvido.

### S12

**Background removal / BiRefNet and BRIA**
- [BiRefNet research weights/model page](https://huggingface.co/guan2/BiRefNet)
- [Official BiRefNet GitHub](https://github.com/ZhengPeng7/BiRefNet)
- [BRIA RMBG-2.0 model card](https://huggingface.co/briaai/RMBG-2.0)
- **Suporta:** BiRefNet como candidato para foreground segmentation; BRIA RMBG-2.0 self-hosted weights têm licença CC BY-NC 4.0, uso comercial condicionado a acordo. Não fundir licenças dos dois projetos.

### S13

**CheXpert**
- [Stanford AIMI CheXpert](https://aimi.stanford.edu/datasets/chexpert-chest-x-rays)
- [CheXpert download/research information](https://stanfordmlgroup.github.io/competitions/chexpert/)
- [TensorFlow Datasets — research-use agreement note](https://tensorflow.google.cn/datasets/catalog/chexpert)
- **Suporta:** 224.316 radiografias, 65.240 pacientes, labels com incerteza; acordo de acesso para pesquisa. Não redistribuir sem permissão.

### S14

**VinDr-CXR**
- [PhysioNet dataset](https://physionet.org/content/vindr-cxr/1.0.0/)
- [PhysioNet license](https://physionet.org/content/vindr-cxr/view-license/1.0.0/)
- **Suporta:** dados de radiografia com anotação radiológica; download exige credenciamento, treinamento CITI e DUA, uso restrito à pesquisa legítima.

### S15

**Segment Anything 2 (SAM 2)**
- [Meta official SAM 2 repository](https://github.com/facebookresearch/sam2)
- **Suporta:** imagem/vídeo, pesos e código sob Apache-2.0 conforme README. Benchmarks de MPS/CPU não foram medidos.

### S16

**Segment Anything 3 and 3.1 (SAM 3)**
- [Meta official SAM 3 repo](https://github.com/facebookresearch/sam3)
- [SAM License](https://github.com/facebookresearch/sam3/blob/main/LICENSE)
- [Meta 2025 introduction](https://about.fb.com/news/2025/11/new-sam-models-detect-objects-create-3d-reconstructions/)
- **Suporta:** promptable segmentation/tracking e SAM 3.1 anunciado 27/03/2026. README exige Python>=3.12, PyTorch>=2.7, CUDA-compatible GPU 12.6+, licença SAM própria. Não presumir Apple MPS.

### S17

**DINOv3**
- [Meta AI research announcement](https://ai.meta.com/blog/dinov3-self-supervised-vision-model/)
- [DINOv3 License](https://github.com/facebookresearch/dinov3/blob/main/LICENSE.md)
- **Suporta:** backbones de representação auto-supervisionada, licença customizada com direitos específicos. Não etiquetar como Apache/MIT.

### S18

**Qwen3-VL**
- [Qwen3-VL official repository](https://github.com/QwenLM/Qwen3-VL)
- [Repository Apache-2.0 LICENSE](https://github.com/QwenLM/Qwen3-VL/blob/main/LICENSE)
- **Suporta:** família VLM, versões 2B/4B/8B divulgadas em outubro de 2025; inspeção por model card e weights necessária.

### S19

**COCO detection evaluation**
- [Official COCO Detection Evaluation](https://cocodataset.org/dataset/detection-eval.htm)
- **Suporta:** AP@[IoU .50:.05:.95] como métrica principal; AP_small/medium/large e Average Recall. Relevante para detection/PPE.

### S20

**HOTA / tracking evaluation**
- [HOTA peer-reviewed article — IJCV](https://link.springer.com/article/10.1007/s11263-020-01375-2)
- [MOTChallenge evaluation scripts](https://github.com/JonathonLuiten/TrackEval)
- **Suporta:** HOTA equilibra detecção, associação e localização; métrica recomendável além de IDF1. Não é licença para usar datasets de terceiros.

### S21

**Open Images V7**
- [Google Open Images V7 description](https://storage.googleapis.com/openimages/web/factsfigures_v7.html)
- [Open Images V7 download/format](https://storage.googleapis.com/openimages/web/download_v7.html)
- [Google Open Images license note (V6)](https://storage.googleapis.com/openimages/web/factsfigures_v6.html)
- **Suporta:** annotations e boxes em grande escala; V6 explicita anotações CC BY 4.0 e imagens listadas CC BY 2.0 **sem garantia de direitos individuais**. Antes de uso em V7, verificar condições atuais por imagem.

### S22

**FAISS**
- [Official FAISS repository](https://github.com/facebookresearch/faiss)
- [License](https://github.com/facebookresearch/faiss/blob/main/LICENSE)
- **Suporta:** similarity search index local com CPU, licença MIT. Não exige DB servidor.

### S23

**MLflow**
- [Official tracking documentation](https://mlflow.org/docs/latest/tracking/)
- [Official ML Evaluation docs](https://mlflow.org/docs/latest/ml/evaluation)
- **Suporta:** tracking de experiments/params/code/metrics/artifacts, avaliação tradicional. Não dispensar lineage do domínio VisionLens.

### S24

**Medical AI / research-to-product boundary**
- [US FDA — Good Machine Learning Practice principles](https://www.fda.gov/medical-devices/artificial-intelligence-enabled-medical-devices/good-machine-learning-practice-medical-device-development-guiding-principles)
- **Suporta:** desenvolvimento regulado precisa de validação abrangente, segurança e lifecycle governance. Este documento não é substituto de enquadramento ANVISA/LGPD para Brasil.

### S25

**PyTorch object detection finetuning**
- [Official TorchVision Object Detection Finetuning Tutorial](https://docs.pytorch.org/tutorials/intermediate/torchvision_tutorial.html)
- **Suporta:** dataset Penn-Fudan (170 imagens, 345 pessoas), exemplo de object detection/instance segmentation. Tutorial não substitui direitos de uso do dataset.

### S26

**Grounding DINO**
- [IDEA Research official repo](https://github.com/IDEA-Research/GroundingDINO)
- **Suporta:** open-set text-grounded object detection e implementação com licença Apache-2.0 no repo. Verificar pesos/dados por versão.

## Research integrity notes

- Nenhum benchmark foi executado neste trabalho; percentuais de fornecedor não foram apresentados como evidência VisionLens.
- A documentação de modelos e licenças é temporal. Pin versions, checkpoints, manifests e URLs antes de criar receitas estáveis.
- Disponibilidade em website ≠ licença comercial ≠ direito de redistribuição ≠ conformidade com privacidade.
- Onde existe contradição entre espelho e autor, classificar como bloqueio até obter evidência de autoridade.
- Fornecedores podem alterar modelos, versionamento, licenças e APIs; as listas não constituem um ranking de performance atual medido.
