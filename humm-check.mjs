import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createHummHook} from './index.js'

const reasoning=(text,index=0)=>({type:'reasoning-delta',text,index})
const finish={type:'finish',reason:{kind:'stop'}}
async function inspect(request,chunks,after=[]){
  const events=[]
  const forwarded=[]
  const hook=createHummHook(()=>{events.push('start');return()=>events.push('stop')})
  for await(const chunk of hook(request,async function*(){yield* chunks})){
    forwarded.push(chunk)
    if(after[forwarded.length-1])assert.deepEqual(events,after[forwarded.length-1])
  }
  assert.deepEqual(forwarded,chunks)
  return events
}

test('检测跨片段的思考语气词，同时忽略正文和相似单词',async()=>{
  const input=[
    reasoning('好，Hu'),reasoning('mm'),reasoning('...... HUM'),reasoning('MMM…'),
    reasoning('humm'),reasoning('ing xhumm hmm humm_3'),
    {type:'text-delta',index:0,text:'humm'},finish,
  ]
  for(const request of [
    {provider:'workbuddy-cn',model:'deepseek-v4.1-flash'},
    {provider:'workbuddy-cn',model:'hy4flash-free'},
    {provider:'openai-codex',model:'gpt-6.1-terra'},
    {},
  ]){
    assert.deepEqual(await inspect(request,input),['start','stop'])
  }
  assert.deepEqual(await inspect({},[reasoning('humming xhumm hmm humm_3'),{type:'text-delta',text:'humm……'},finish]),[])
})
test('首次 humm 开始播放，后面的思考文字和 humm 共用一次播音',async()=>{
  const chunks=[reasoning('hu'),reasoning('mmmm'),reasoning('m'.repeat(2000)),reasoning('......'),reasoning('……'),reasoning(' 再考虑'),reasoning('humm……'),finish]
  const after=[[],['start'],['start'],['start'],['start'],['start'],['start'],['start','stop']]
  assert.deepEqual(await inspect({provider:'deepseek'},chunks,after),['start','stop'])
})
test('思考块切换时连续播放，正文、工具、结束或中止时收音',async()=>{
  const input=[reasoning('hu'),reasoning('mm!',1),reasoning('mm'),{type:'block-end',index:0},reasoning('humm',2),finish]
  assert.deepEqual(await inspect({provider:'deepseek'},input,[[],[],[],['start'],['start'],['start','stop']]),['start','stop'])
  assert.deepEqual(await inspect({provider:'deepseek',signal:AbortSignal.abort()},input),[])
  assert.deepEqual(await inspect({provider:'deepseek'},[reasoning('humm'),{type:'finish',reason:{kind:'error'}}]),[])
  for(const end of [{type:'text-delta',text:'正文'}, {type:'tool-call-delta'}, {type:'finish',reason:{kind:'error'}}]){
    assert.deepEqual(await inspect({provider:'deepseek'},[reasoning('humm...'),end],[['start'],['start','stop']]),['start','stop'])
  }
  const controller=new AbortController()
  const events=[]
  const hook=createHummHook(()=>{events.push('start');return()=>events.push('stop')})
  const iterator=hook({provider:'deepseek',signal:controller.signal},async function*(){yield reasoning('humm...')})
  await iterator.next()
  controller.abort()
  assert.deepEqual(events,['start','stop'])
  await iterator.return()
  assert.deepEqual(events,['start','stop'])
})
