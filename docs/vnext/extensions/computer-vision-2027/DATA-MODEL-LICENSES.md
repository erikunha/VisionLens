# License, Data Governance and Release Gate Matrix

**Revisão documental:** 15/11/2026. Esta tabela é pesquisa e triagem de risco, **não parecer jurídico nem autorização de download/publicação**. Sempre revisar licença exata do código, *weights*, dataset, imagens individuais e outputs derivados antes de redistribuição ou exploração comercial. Datasets **não** vêm inclusos no pacote.

## 1. Dataset/source matrix

| Recurso / tarefa | Fonte | Direitos/acesso observados | Decisão para VisionLens |
|---|---|---|---|
| **Oxford-IIIT Pet** 09/10/14/15 | [S02](SOURCES.md#s02) | Oxford lista CC BY-SA 4.0 para dataset comercial/pesquisa e lembra copyright dos titulares originais das imagens | **Candidato principal**; atribuição/ShareAlike + validação dos direitos e exemplos redistribuíveis; preferir download por usuário e hashes em vez de imagens no Git |
| **Open Images V7** 10/13 | [S21](SOURCES.md#s21) | anotações CC BY 4.0; imagens listadas CC BY 2.0, Google **não garante licença de cada imagem** | subset curado com direitos e metadata por item; não baixar 9M imagens automaticamente |
| **UFPR-ALPR** 11 | [S08](SOURCES.md#s08) | pesquisa acadêmica/não comercial; sem redistribuir/modificar/comercializar sem permissão expressa | **research-only**; para demo pública usar dados sintéticos ou imagem consentida; verificar acesso/autorização |
| **SHWD (hardhat)** 13 | [S09](SOURCES.md#s09) | repo MIT, porém fotos provêm parcialmente de buscas web; origem individual de imagens não necessariamente coberta pelo LICENSE do código | **gate de direitos**; usar apenas quando auditoria de imagens permitir, não embutir no ZIP |
| **MOT17** 12 | [S20](SOURCES.md#s20) para métrica; verificar benchmark | estudos reportam CC BY-NC-SA 3.0, site original com disponibilidade oscilante | **não redistribuir/uso comercial** até confirmar diretamente com custodiante; preferir clips consentidos |
| **P3M-10K** 15 | [S10](SOURCES.md#s10) | acordo original apresenta MIT; portraits incluindo imagens em versão sem blur; direitos de retrato e divulgação requerem cautela | pesquisa e protótipo local; não publicar fotos identificáveis; registrar acordo aceito |
| **DIS5K** 15 | [S11](SOURCES.md#s11) | **termos originais**: pesquisa/educação não comercial e vedação de redistribuição, embora mirror HuggingFace indique Apache-2.0 | **bloqueio comercial e de bundle**, priorizar termos da fonte original; não confiar na tag do mirror |
| **CheXpert** 16 | [S13](SOURCES.md#s13) | acesso sob *Research Use Agreement*, imagens clínicas e labels de incerteza | **research-only / restrito**; governança de paciente, nenhuma imagem no Git |
| **VinDr-CXR** 16 | [S14](SOURCES.md#s14) | credenciamento, CITI, DUA e restrições de distribuição | **research-only / gated**; proibido scraping e cópia para demo pública |
| **Imagens próprias autorizadas** 10/12/13/15 | fonte produzida pelo projeto | depende dos direitos de fotografados, propriedade e consentimento | rota preferencial para demo; separar consentimento, retenção e circulação pública |
| **Sintéticos controlados** 11/12/13 | gerador + assets com licença | registrar licenças de fundos, fonte, caracteres e gerador; risco de correspondência com dados reais | fixtures de CI e demo sem dados pessoais; **não** usar como única evidência de performance real |

### Alerta especial: DIS5K

A página do espelho `nobg/DIS5K` informa licença Apache-2.0, mas o PDF de termos do dataset do autor, inspecionado nesta pesquisa, restringe a usos não comerciais de pesquisa/educação e **proíbe distribuição**. O VisionLens deve registrar `LICENSE_CONFLICT` e bloquear download/uso comercial por default até revisão jurídica/autoridade do autor. Não copiar a tag do mirror como licença final. [S11](SOURCES.md#s11)

## 2. Model + code matrix

| Modelo / projeto | Licença observada em fonte | Limite operacional | Política proposta |
|---|---|---|---|
| Torchvision pretrained | código PyTorch e checkpoints por artefato | pesos e origem por versão | padrão quando compatível; snapshot de modelo |
| SigLIP2 base (Google HF) | ficha do checkpoint `apache-2.0` | ~1,5 GB de weights para uma variante, memória real a medir | opcional `[vision]`, pesos sob cache, não na distribuição [S03](SOURCES.md#s03) |
| RT-DETR (repo) | Apache-2.0 no projeto | licença de pesos/dados deve ser revisada | detector de referência permitido após auditoria [S04](SOURCES.md#s04) |
| Ultralytics YOLO26 | AGPL-3.0 ou Enterprise; documentação declara que modelos treinados com YOLO também ficam sob AGPL por padrão | risco para SaaS proprietário ou embeddings fechados | adapter opcional licenciado; gate de publicação comercial [S05](SOURCES.md#s05) |
| Meta SAM 2 | código/checkpoints Apache-2.0 | memória MPS/CPU não inferida da licença | pack experimental optional [S15](SOURCES.md#s15) |
| Meta SAM 3/3.1 | SAM License customizada | projeto oficial requer Python 3.12, PyTorch >=2.7, CUDA 12.6+ | não baseline em Mac; pesquisa com CUDA+revisão [S16](SOURCES.md#s16) |
| Meta DINOv3 | licença customizada DINOv3 | termos de redistribuição específicos | não tratar como MIT/Apache [S17](SOURCES.md#s17) |
| PaddleOCR | projeto Apache-2.0 | modelo específico pode ter termos/dep. próprios | OCR especializado, extras instalados sob demanda [S07](SOURCES.md#s07) |
| Qwen3-VL | repo Apache-2.0 | revisar model card/weights e hardware de cada tamanho | VLM experimental; não depender para core [S18](SOURCES.md#s18) |
| BRIA RMBG-2.0 | self-hosted weights CC BY-NC 4.0, comercial sob licença | pesa ~1GB em ONNX full; modelo gated | não distribuir por default nem usar como backend comercial sem acordo [S12](SOURCES.md#s12) |
| BiRefNet | source e pesos hospedados separadamente | versão exata e modelo possuem ficha própria | permissões verificadas por checkpoint, sem suposição global [S12](SOURCES.md#s12) |
| FAISS | MIT code | wheels CPU e recursos de RAM | índice local se benchmark justificar [S22](SOURCES.md#s22) |

**Não usar `trust_remote_code=True`, `torch.load` ou pickle de checkpoint baixado de origem não verificada em worker com acesso a dados privados.** Pesos `safetensors` quando disponíveis e fontes pinadas em revisão são preferíveis, mas não eliminam risco de implementação/CI.

## 3. Campos mínimos de `DatasetLicenseRecord` / `ModelLicenseRecord` (proposta)

```yaml
# Exemplo conceptual; NÃO é schema aprovado pela aplicação
resource_id: oxford_pets_public_suite_v1
kind: dataset
source_url: https://www.robots.ox.ac.uk/~vgg/data/pets/
source_revision: "checked-2026-11-15"
license_expression: "CC-BY-SA-4.0" # interpretar conforme documentação do autor
license_evidence_url: https://www.robots.ox.ac.uk/~vgg/data/pets/
license_checked_at: "2026-11-15"
rights_review: pending
redistribution_allowed: unknown
commercial_use_allowed: pending_review
contains_personal_data: false # verificar conteúdo e metadados antes de aprovar
publish_raw_samples: false
authorized_use: local_research_until_review
```

**Workflow de liberação**: `UNREVIEWED → RESEARCH_ONLY | REVIEWED_COMPATIBLE | BLOCKED`; alteração de licença invalida estado de cache para publicação; import precisa carregar attribution/citation/usage terms por dataset e modelo. `publish_raw_samples` e `commercial_use_allowed` são decisões de governança, não deduções por IA.

## 4. Privacidade e segurança por pipeline

| Tipo de dado | Risco principal | Default e requisito antes de publicar |
|---|---|---|
| Placa | identificador de veículo e localização indireta | synthetic only; redact thumbnails/logs, disable search por placa em material público |
| Vídeo de pessoas | biometria incidental, comportamento, retenção | processamento local offline, `trackId` efêmero, agregação, consentimento, expiração |
| EPI/pessoas | falsa alegação de descumprimento, dados de trabalhador | rótulo `unknown`, human review, sem ranking/perfil individual |
| Radiografia | dado sensível de saúde e risco clínico | workspace isolado, DUA/ética, no samples/logs, research-only |
| Retratos P3M | conteúdo de pessoas, direitos de imagem | evitar rostos identificáveis; uso consentido ou acordo permissivo detalhado |
| Metadados de imagens | GPS/EXIF sensível | EXIF redaction em derivados e mídias públicas |
| Textos detectados via OCR | prompt injection, PII, segredos | texto não confiável; zero tool execution a partir de OCR |

### Release gate checklist

- [ ] Existe fonte primária com URI, data de checagem, licença **de imagem, código, pesos e anotações**.
- [ ] Um humano validou que o uso pretendido (educação, portfolio, rede pública, produto comercial) é permitido.
- [ ] Foi verificado se redistribuir no GitHub/ZIP/screenshots está permitido, com atribuição e ShareAlike quando necessário.
- [ ] Consentimento, base legal e política de retenção foram definidos para pessoas, placas e saúde.
- [ ] Model card contém intended use, limitações, eval data e dados de treino quando informados.
- [ ] Os assets têm hash e *source license ID* com lineage; não existe `LICENSE_UNKNOWN` em publicação.
- [ ] O worker não faz egress de imagens sem aprovação/escopo.
- [ ] Artefatos derivados e index embeddings podem ser apagados por política auditável.
- [ ] Evidência de benchmark é independente dos dados de treino e não vaza imagens restritas.
