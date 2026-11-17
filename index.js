import path from 'node:path'
import {statSync} from 'node:fs'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'

export const name='konata-humm'
export const inject=['llm']

const wordCharacter=/^[a-z0-9_]$/
const HUMM='humm'
const bundledAudio=fileURLToPath(new URL('./build/konata-humm.wav',import.meta.url))

function inspectStream(start){
  const words=new Map()
  let stopPlayback=null
  const play=()=>{stopPlayback??=start()}
  const finishBlock=index=>{
    if(words.get(index)===HUMM)play()
    words.delete(index)
  }
  const finishReasoning=completed=>{
    if(completed&&[...words.values()].includes(HUMM))play()
    words.clear()
    stopPlayback?.()
    stopPlayback=null
  }
  const inspect=chunk=>{
    if(chunk.type==='reasoning-delta'&&typeof chunk.text==='string'){
      if(stopPlayback)return
      let word=words.has(chunk.index)?words.get(chunk.index):''
      for(const character of chunk.text){
        const letter=character.toLowerCase()
        const isWord=wordCharacter.test(letter)
        if(word===HUMM&&(letter==='m'||!isWord)){
          play()
          words.clear()
          return
        }
        if(!isWord){
          word=''
        }else if(word!==null&&letter===HUMM[word.length]){
          word+=letter
        }else{
          word=null
        }
      }
      words.set(chunk.index,word)
    }else if(chunk.type==='block-end'){
      finishBlock(chunk.index)
    }else if(chunk.type==='text-delta'||chunk.type==='tool-call-delta'){
      finishReasoning(true)
    }else if(chunk.type==='finish'){
      finishReasoning(chunk.reason?.kind==='stop')
    }
  }
  return {inspect,close:()=>finishReasoning(false)}
}

export function createHummHook(start){
  return async function*(request,next){
    const {inspect,close}=inspectStream(start),signal=request.signal
    signal?.addEventListener('abort',close,{once:true})
    try{
      for await(const chunk of next()){
        if(!signal?.aborted)inspect(chunk)
        yield chunk
      }
    }finally{
      signal?.removeEventListener('abort',close)
      close()
    }
  }
}

export function apply(ctx,config={}){
  if(config.enabled===false||!['darwin','win32'].includes(process.platform))return
  const extension=process.platform==='win32'?'.exe':''
  const playerPath=fileURLToPath(new URL(`./build/${process.platform}-${process.arch}/konata-humm-player${extension}`,import.meta.url))
  const audioPath=config.audioPath??bundledAudio
  const volume=config.volume??1,fadeInMs=config.fadeInMs??220,fadeOutMs=config.fadeOutMs??420
  const validFade=value=>Number.isSafeInteger(value)&&value>=0&&value<=5000
  if(typeof audioPath!=='string'||!path.isAbsolute(audioPath)||!Number.isFinite(volume)||volume<0||volume>1
    ||!validFade(fadeInMs)||!validFade(fadeOutMs))throw new Error('泉此方提示音设置无效')

  let player=null,disposed=false,warned=false
  const active=new Set()
  const warn=()=>{
    if(warned||disposed)return
    warned=true
    ctx.logger?.warn?.('泉此方提示音无法播放，请检查本地音频和播放器。')
  }
  function openPlayer(){
    if(player&&!player.stdin.destroyed)return player
    try{
      if(!statSync(audioPath).isFile())throw new Error('无可播放音频')
      const child=spawn(playerPath,[audioPath,String(volume),String(fadeInMs),String(fadeOutMs)],{stdio:['pipe','ignore','ignore'],windowsHide:true})
      player=child
      child.stdin.on('error',warn)
      child.on('error',warn)
      child.once('close',code=>{if(player===child)player=null;if(code!==0)warn()})
      return child
    }catch{warn()}
  }
  const start=()=>{
    if(disposed)return ()=>{}
    const occurrence=Symbol()
    active.add(occurrence)
    if(active.size===1||!player||player.stdin.destroyed)openPlayer()?.stdin.write('start\n')
    return ()=>{
      if(active.delete(occurrence)&&!active.size&&player&&!player.stdin.destroyed)player.stdin.write('stop\n')
    }
  }
  const off=ctx.on('llm/stream',createHummHook(start))
  return ()=>{
    disposed=true
    off?.()
    active.clear()
    if(player&&!player.stdin.destroyed)player.stdin.end('quit\n')
  }
}
