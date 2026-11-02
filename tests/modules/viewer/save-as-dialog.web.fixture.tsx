import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SaveAsDialog } from '../../../src/modules/viewer/components/SaveAsDialog.js'
import { readerLocales } from '../../../src/modules/viewer/locales.js'

interface Input { replaceConfirm?: boolean; error?: string; busy?: boolean }
let configure: (input: Input) => void = () => {}

function Fixture() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('概率论与数理统计-annotated.pdf')
  const [directory, setDirectory] = useState('/Users/reader/Documents/学习资料')
  const [input, setInput] = useState<Input>({})
  configure = changes => setInput(current => ({ ...current, ...changes }))
  const t = (key: string) => readerLocales.zh[key] ?? key
  return <div className="dsh-pdf-reader">
    <div style={{ position: 'absolute', inset: 16, display: 'flex', alignItems: 'flex-start', gap: 18 }}>
      <div className="dsh-pdf-glass" style={{ padding: 7, borderRadius: 18, border: '0.5px solid var(--pdf-glass-edge)' }}>
        <button id="save-copy-trigger" type="button" onClick={() => setOpen(true)}>{t('reader.saveAs')}</button>
      </div>
      <article style={{ flex: 1, minWidth: 0, maxWidth: 560, minHeight: 720, padding: 38,
        background: '#fff', color: '#222', boxShadow: '0 2px 8px #0003, 0 12px 35px #0002' }}>
        <p style={{ fontSize: 13, textAlign: 'right', margin: '0 0 40px' }}>第一章　概率论的基本概念</p>
        <h2 style={{ fontSize: 22, marginBottom: 24 }}>§ 2　样本空间、随机事件</h2>
        <p style={{ fontSize: 17, lineHeight: 2 }}>在概率论中，我们将具有随机结果的实验称为随机试验。描述每次试验的所有可能结果，可以帮助我们理解随机现象。</p>
        <p style={{ fontSize: 17, lineHeight: 2 }}>阅读时添加的标注与批注，可以连同文档一起保存到新的 PDF 文件中。</p>
      </article>
    </div>
    {open && <SaveAsDialog name={name} directory={directory} pickerAvailable={false} picking={false}
      busy={!!input.busy} targetChecking={false} target={{ path: `${directory}/${name}`, version: null }}
      replaceConfirm={!!input.replaceConfirm} error={input.error ?? ''} onNameChange={setName} onDirectoryChange={setDirectory}
      onChooseDirectory={() => { throw new Error('This fixture has no native directory picker.') }}
      onSubmit={() => setOpen(false)} onCancel={() => setOpen(false)}
      onBack={() => setInput(current => ({ ...current, replaceConfirm: false }))} t={t} />}
  </div>
}

createRoot(document.getElementById('save-as-root')!).render(<Fixture />)
Object.assign(window, { __pdfSaveAsDialogFixture: { set: (input: Input) => configure(input) } })
