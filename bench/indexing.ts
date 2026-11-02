import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir, cpus, platform, arch } from 'node:os'
import { join } from 'node:path'
import { createRetrievalStore } from '../src/adapters/host/filesystem/retrieval-store.js'
import { createRetrievalService } from '../src/modules/retrieval/service.js'
import { digest } from '../src/modules/retrieval/cache.js'
import type { RetrievalPorts, RetrievalPage } from '../src/modules/retrieval/types.js'

async function diskBytes(directory: string): Promise<{ files: number; bytes: number }> {
  let files = 0, bytes = 0
  for (const entry of await readdir(directory, {withFileTypes:true})) {
    const path = join(directory,entry.name)
    if (entry.isDirectory()) { const child = await diskBytes(path); files += child.files; bytes += child.bytes }
    else if (entry.isFile()) { files++; bytes += (await stat(path)).size }
  }
  return { files, bytes }
}
async function scenario(pages: number, paragraphs: number) {
  const directory = await mkdtemp(join(tmpdir(),'pdf-index-storage-perf-'))
  let store = createRetrievalStore({directory, maxMemoryBytes: 8 * 1024 * 1024, maxRecordBytes:64*1024*1024})
  const calls: Record<string,{count:number;ms:number}> = Object.create(null)
  let pageReads=0, docBatches=0, docTexts=0
  const category=(key:string)=>key.startsWith('index_head_')?'head':key.startsWith('index_page_')?'page-checkpoint':'derived'
  const cache={
    async get(key:string) { const start=performance.now(); try{return await store.get(key)} finally {const id='get:'+category(key);const c=calls[id]??={count:0,ms:0};c.count++;c.ms+=performance.now()-start} },
    async set(key:string,value:unknown) { const start=performance.now(); try{await store.set(key,value)} finally {const id='set:'+category(key);const c=calls[id]??={count:0,ms:0};c.count++;c.ms+=performance.now()-start} },
    has: (key: string) => store.has(key),
    async setMany(entries: readonly (readonly [string, unknown])[]) {
      const start = performance.now()
      try { await store.setMany(entries) }
      finally { const c = calls['setMany'] ??= { count: 0, ms: 0 }; c.count++; c.ms += performance.now() - start }
    },
    delete:(key:string)=>store.delete(key), clear:()=>store.clear(),
  }
  const ports: RetrievalPorts={
    cache,
    documents:{snapshot:(_s,id)=>({id,path:'/synthetic/index-perf.pdf',sourceDigest:'synthetic-source',contentVersion:'synthetic-source',pageCount:pages})},
    pages:{identity:()=> 'fixture-native-v1', async read(_s,_d,page):Promise<RetrievalPage>{
      pageReads++
      const text=Array.from({length:paragraphs},(_,p)=>`Page ${page} paragraph ${p}. `+'Index storage words. '.repeat(25)).join('\n\n')
      const spans=Array.from({length:Math.ceil(text.length/10)},(_,i)=>({startUtf16:i*10,endUtf16:Math.min(text.length,i*10+10),rectPdf:[1,i,2,i+1] as [number,number,number,number]}))
      return {text,source:'pdf-text',units:[{id:`native-${page}`,blockId:`native-${page}`,kind:'native-text',text,digest:`sha256:${digest(text)}`,nativeRange:{startUtf16:0,endUtf16:text.length},spans}]}
    }},
    embedding:{select:()=>({fingerprint:'fixture-1024',documentFingerprint:'fixture-1024',dimensions:1024,maxBatchSize:16,maxInputCharacters:1200,
      async embed(texts,purpose){if(purpose==='document'){docBatches++;docTexts+=texts.length}return texts.map(()=>Array.from({length:1024},(_,i)=>i===0?1:0))}})},
  }
  let service=createRetrievalService(ports)
  try {
    const start=performance.now(),cpu=process.cpuUsage()
    await service.prepare('a',{documentId:'doc'})
    const used=process.cpuUsage(cpu),coldMs=performance.now()-start
    const cold={ms:coldMs,cpuMs:(used.user+used.system)/1000,io:structuredClone(calls),store:store.diagnostics(),pageReads,docBatches,docTexts,disk:await diskBytes(directory)}
    const warmStart=performance.now()
    await service.prepare('a',{documentId:'doc'})
    const warmMs=performance.now()-warmStart
    await service.dispose();await store.dispose()
    store=createRetrievalStore({directory,maxMemoryBytes:8*1024*1024,maxRecordBytes:64*1024*1024})
    for(const key of Object.keys(calls)) delete calls[key]
    service=createRetrievalService(ports)
    const restoreStart=performance.now(),restoreCpu=process.cpuUsage()
    await service.prepare('b',{documentId:'doc'})
    const restoreUsed=process.cpuUsage(restoreCpu)
    const restored={ms:performance.now()-restoreStart,cpuMs:(restoreUsed.user+restoreUsed.system)/1000,io:structuredClone(calls),store:store.diagnostics(),additionalPageReads:pageReads-cold.pageReads,additionalDocBatches:docBatches-cold.docBatches}
    return {pages,paragraphs,dimensions:1024,cold,warmMs,restored}
  } finally {await service.dispose();await store.dispose();await rm(directory,{recursive:true,force:true})}
}
const result={scope:'Synthetic real-filesystem diagnostic; no PDFium, OCR, inference, network or user data. Warm OS file cache is not flushed. Times include validation/chunking and file durability calls. No before/after improvement claim.',environment:{platform:platform(),arch:arch(),node:process.version,cpu:cpus()[0]?.model},runs:[] as any[]}
for(let repeat=0;repeat<3;repeat++)for(const [pages,paragraphs] of [[32,1],[16,8],[1,128]])result.runs.push({repeat,...await scenario(pages!,paragraphs!)})
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result,null,2))
console.log(JSON.stringify(result,null,2))
