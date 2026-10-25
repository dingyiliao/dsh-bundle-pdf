/**
 * Frozen synthetic truth, authored before ranking this corpus. This small corpus
 * exercises retrieval behavior; it is not a production PDF/agent accuracy claim.
 * Page numbers are assigned in this array's order. Text deliberately includes
 * duplicate passages and semantically close distractors.
 */
export const retrievalCorpusVersion = 'synthetic-retrieval-v1'

export const retrievalPassages = [
  { id: 'random-experiment', text: '随机试验可以在相同条件下重复进行。每次试验的可能结果不止一个，试验前无法确定具体出现哪个结果，但可以列出所有可能结果。掷骰子是一个例子。' },
  { id: 'independent-events', text: 'Two events are independent when observing one does not change the probability of the other. Independence concerns information about likelihood, rather than whether both events can occur together.' },
  { id: 'exclusive-events', text: '互斥事件不能同时发生。对于两个概率都大于零的互斥事件，一个事件发生意味着另一个不发生，因此它们并不独立。互斥与独立是不同的关系。' },
  { id: 'conditional-probability', text: 'Conditional probability measures how likely an event is after restricting the sample space to outcomes where another event has occurred. The denominator is the probability of the conditioning event, which must be positive.' },
  { id: 'bayes', text: '贝叶斯公式用新证据更新假设的可信程度。后验概率与先验概率乘以似然成正比，再通过证据的总概率进行归一化。先验并不是观察新证据之后得到的概率。' },
  { id: 'large-numbers', text: '大数定律描述大量独立重复试验中的样本平均值趋近总体期望的现象。它不保证短时间内每个结果均匀出现，也不意味着连续几次失败后下一次必然成功。' },
  { id: 'convolution', text: 'A convolutional layer reuses the same small set of filter weights at different spatial locations. This parameter sharing reduces the number of learned weights and allows a feature detector to recognize a local pattern wherever it appears in the image.' },
  { id: 'overfitting', text: '模型在训练数据上表现很好而在新数据上表现差，可能是过拟合。正则化、更多训练样本和合理的模型容量可以缓解过拟合；只追求训练误差下降并不能保证泛化。' },
  { id: 'dropout-training', text: 'During training, dropout randomly disables a subset of activations on each forward pass. The changing subnetworks discourage features from relying on a fixed set of partner features, which can reduce overfitting.' },
  { id: 'dropout-evaluation', text: 'During evaluation or prediction, standard dropout is disabled. All units participate, and the scaling convention chosen during training preserves the expected activation magnitude. Evaluation must not randomly drop units as if it were training.' },
  { id: 'attention', text: '注意力机制通过查询与键的相似度计算权重，再对值进行加权求和。它让每个位置根据当前上下文选择应关注的信息，而不是始终依赖一个固定大小的局部窗口。' },
  { id: 'gradient-descent', text: 'Gradient descent adjusts parameters in the direction opposite to the gradient of a differentiable loss. The learning rate controls the step size. An excessively large step can overshoot a minimum or cause divergence.' },
  { id: 'transaction-atomicity', text: 'An atomic database transaction commits all of its changes together or none of them. If a transfer fails after debiting one account, rollback prevents a partial update from leaving money missing from the system.' },
  { id: 'transaction-isolation', text: 'Transaction isolation defines which intermediate changes concurrent transactions can observe. Stronger isolation can prevent anomalies such as reading uncommitted data, but it is a different guarantee from all-or-nothing atomicity.' },
  { id: 'database-index', text: '数据库索引维护按键组织的辅助结构，以减少查询时需要扫描的记录。索引会占用额外空间，插入和更新记录时也需要维护，因此并不是索引越多越好。' },
  { id: 'cache-invalidation', text: 'A cached result must be tied to the inputs and algorithm version that produced it. When the source content changes, stale entries must be invalidated or verified before reuse. Changing only a display preference need not invalidate a text index.' },
  { id: 'shared-draft', text: 'PDF 阅读器和模型工具使用同一份 Host 工作副本。修改先进入可撤销草稿，所有已打开视图同步更新。关闭某一个视图并不等于丢弃草稿，也不应该创建另一份互相冲突的副本。' },
  { id: 'save-confirmation', text: '模型添加或修改标注会直接更新未保存草稿，不需要额外的预览提交步骤。真正覆盖原 PDF 文件的保存操作仍需要用户确认，并在写入前重新校验磁盘源文件。' },
  { id: 'scanned-pages', text: 'A scanned PDF page may contain a single image and no searchable native text. OCR can create a textual transcription for retrieval. OCR output is derived evidence and does not automatically provide reliable native glyph coordinates for exact highlighting.' },
  { id: 'formula-context', text: '公式周边的段落可以解释符号含义和适用条件，但提取出来的文字可能丢失上下标、分式结构或矩阵布局。理解公式时应结合原始页面，不能把损坏的字符顺序当作完整数学表达式。' },
  { id: 'duplicate-first', text: 'The calibration marker is amber kestrel. Record the physical page before jumping to this exact passage; identical wording may occur in another location.' },
  { id: 'duplicate-second', text: 'The calibration marker is amber kestrel. Record the physical page before jumping to this exact passage; identical wording may occur in another location.' },
  { id: 'photosynthesis', text: '光合作用利用光能，将二氧化碳和水转化为储存化学能的有机物，并释放氧气。叶绿体是植物细胞中进行光合作用的主要场所。' },
  { id: 'respiration', text: 'Cellular respiration releases usable energy by breaking down organic molecules. In aerobic respiration, oxygen participates in the process and carbon dioxide is released. Respiration is not the same process as storing light energy through photosynthesis.' },
  { id: 'bread-yeast', text: 'Yeast fermentation produces carbon dioxide in bread dough. The gas is trapped by the dough structure and increases its volume. High heat eventually kills the yeast, while the loaf structure sets during baking.' },
  { id: 'altitude-boiling', text: '海拔较高时，大气压通常较低，水会在低于海平面沸点的温度沸腾。虽然更容易沸腾，但沸水温度较低，某些食物反而需要更长的烹煮时间。' },
  { id: 'hybrid-search', text: 'Hybrid retrieval combines lexical matching with semantic similarity. Lexical search is useful for exact names and unusual identifiers; dense embeddings can retrieve paraphrases that share little wording. Rank fusion combines ordered result lists without treating unlike scores as comparable probabilities.' },
  { id: 'chart-ocr', text: 'OCR identifies printed characters in a chart, such as axis labels and numbers. Reading those characters alone does not establish the trend, relationships between plotted series, or the meaning of an illustration. Visual understanding must examine the original image.' },
] as const

export interface RetrievalQuery {
  id: string
  kind: 'exact' | 'paraphrase' | 'cross-language' | 'negation' | 'duplicate' | 'no-answer'
  query: string
  relevant: readonly string[]
}

export const retrievalQueries: readonly RetrievalQuery[] = [
  { id: 'q-experiment', kind: 'paraphrase', query: '每次条件相同，却不能提前确定结果的实验，书里如何定义？', relevant: ['random-experiment'] },
  { id: 'q-independence', kind: 'paraphrase', query: 'Learning that one event occurred gives no information about the chance of the other. What relationship is this?', relevant: ['independent-events'] },
  { id: 'q-exclusive', kind: 'negation', query: '互斥事件为什么通常不能当成独立事件？', relevant: ['exclusive-events'] },
  { id: 'q-bayes', kind: 'cross-language', query: 'How does fresh evidence update a prior belief into a posterior?', relevant: ['bayes'] },
  { id: 'q-large-numbers', kind: 'cross-language', query: 'Why does the average of many repeated random trials stabilize near its expected value?', relevant: ['large-numbers'] },
  { id: 'q-convolution', kind: 'cross-language', query: '为什么识别图片不同位置的同一局部特征不需要各自训练一套参数？', relevant: ['convolution'] },
  { id: 'q-overfit', kind: 'paraphrase', query: '训练集几乎全对，换新样本就错得很多，可以采取什么措施？', relevant: ['overfitting'] },
  { id: 'q-dropout-train', kind: 'exact', query: 'dropout randomly disables activations during training', relevant: ['dropout-training'] },
  { id: 'q-dropout-eval', kind: 'negation', query: 'Should dropout still randomly remove units when making predictions?', relevant: ['dropout-evaluation'] },
  { id: 'q-attention', kind: 'cross-language', query: 'Which mechanism weights values using the similarity between queries and keys?', relevant: ['attention'] },
  { id: 'q-transfer', kind: 'paraphrase', query: 'A money transfer crashes after subtracting from one account. Which guarantee prevents half the transfer from remaining?', relevant: ['transaction-atomicity'] },
  { id: 'q-isolation', kind: 'exact', query: 'transaction isolation reading uncommitted data', relevant: ['transaction-isolation'] },
  { id: 'q-index', kind: 'cross-language', query: 'Why can adding more database indexes slow down inserts and updates?', relevant: ['database-index'] },
  { id: 'q-cache', kind: 'paraphrase', query: 'When can a previously computed search index be reused, and when must its inputs be checked again?', relevant: ['cache-invalidation'] },
  { id: 'q-draft', kind: 'paraphrase', query: '模型改完 PDF，我在另一个阅读标签页里为什么也能立刻看到？', relevant: ['shared-draft'] },
  { id: 'q-approval', kind: 'negation', query: '模型改标注和真正保存原文件，哪一步需要用户批准？', relevant: ['save-confirmation'] },
  { id: 'q-scan', kind: 'cross-language', query: '扫描件里搜不到任何文字，如何让它参与检索？', relevant: ['scanned-pages'] },
  { id: 'q-duplicate', kind: 'duplicate', query: 'amber kestrel calibration marker', relevant: ['duplicate-first', 'duplicate-second'] },
  { id: 'q-bread', kind: 'paraphrase', query: 'What generates the bubbles that make bread dough rise before baking?', relevant: ['bread-yeast'] },
  { id: 'q-boiling', kind: 'cross-language', query: 'Why can food take longer to cook in boiling water high in the mountains?', relevant: ['altitude-boiling'] },
  { id: 'q-chart', kind: 'negation', query: 'Can recognized chart labels alone prove the trend shown by a plotted line?', relevant: ['chart-ocr'] },
  { id: 'q-no-answer-a', kind: 'no-answer', query: 'What premium does the Zephyr submarine insurance policy charge?', relevant: [] },
  { id: 'q-no-answer-b', kind: 'no-answer', query: '玄鹤星际港的通行证编号和续期费用是多少？', relevant: [] },
]

/** Not mixed into text recall: no fabricated image/OCR/layout evidence is supplied. */
export const complexPageLimitations = [
  { scenario: 'image-only-chart', availableText: '', expected: 'uncovered: no OCR/visual index; absence of text matches is not proof of no answer' },
  { scenario: 'formula-with-lost-layout', availableText: 'x 2 + y 2 = z 2', expected: 'text candidate only; no claim of recovered superscripts or mathematical equivalence' },
  { scenario: 'interleaved-columns', availableText: 'left heading right heading\nleft sentence right sentence', expected: 'preserve extraction order; require native geometry/context verification before marking' },
] as const
