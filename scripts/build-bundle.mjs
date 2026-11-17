import {execFileSync} from 'node:child_process'
import {accessSync,constants,copyFileSync,mkdirSync,renameSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const root=fileURLToPath(new URL('../',import.meta.url))
const build=path.join(root,'build')
const native=path.join(root,'native')
const licenses=path.join(build,'licenses')
const audio=path.join(build,'konata-humm.wav')
const targets=[
  {platform:'darwin',arch:'arm64',goos:'darwin',goarch:'arm64'},
  {platform:'darwin',arch:'x64',goos:'darwin',goarch:'amd64'},
  {platform:'win32',arch:'arm64',goos:'windows',goarch:'arm64'},
  {platform:'win32',arch:'x64',goos:'windows',goarch:'amd64'},
]
const modules=[
  ['github.com/ebitengine/oto/v3','oto'],
  ['github.com/ebitengine/purego','purego'],
  ['golang.org/x/sys','golang-x-sys'],
]
const player=target=>path.join(build,`${target.platform}-${target.arch}`,`konata-humm-player${target.platform==='win32'?'.exe':''}`)
const go=(args,options={})=>execFileSync('go',args,{cwd:native,encoding:'utf8',...options})?.trim()
const writeLicense=(directory,label)=>{
  const destination=path.join(licenses,label+'.txt')
  const temporary=destination+'.'+process.pid+'.tmp'
  copyFileSync(path.join(directory,'LICENSE'),temporary)
  renameSync(temporary,destination)
}

if(!process.argv.includes('--check')){
  mkdirSync(licenses,{recursive:true})
  for(const target of targets){
    const output=player(target)
    mkdirSync(path.dirname(output),{recursive:true})
    go(['build','-mod=readonly','-trimpath','-ldflags','-s -w','-o',output,'.'],{
      env:{...process.env,GOOS:target.goos,GOARCH:target.goarch,CGO_ENABLED:'0'},
      stdio:'inherit',
    })
  }
  writeLicense(go(['env','GOROOT']),'go')
  for(const [module,label] of modules){
    const directory=go(['list','-m','-f','{{.Dir}}',module])
    writeLicense(directory,label)
  }
  const source=process.env.KONATA_HUMM_SOURCE??path.join(process.env.DSH_HOME??path.join(os.homedir(),'.dsh'),'konata-humm.m4a')
  execFileSync('ffmpeg',['-nostdin','-v','error','-y','-i',source,'-map','0:a:0','-c:a','pcm_s16le',audio],{stdio:'inherit'})
}

for(const target of targets)accessSync(player(target),constants.R_OK)
for(const name of ['go',...modules.map(([,label])=>label)])accessSync(path.join(licenses,name+'.txt'),constants.R_OK)
accessSync(audio,constants.R_OK)
