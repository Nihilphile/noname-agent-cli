'use strict';
const fs=require('node:fs'),path=require('node:path');
const FILE=path.resolve(__dirname,'../.noname-agent-installation.json');
const EXECUTABLE_NAMES=['无名杀.exe','noname.exe'];
function defaults(file=FILE,env=process.env){
  let saved={};try{saved=JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw Object.assign(Error('安装配置无法读取，请重新运行 setup --source 游戏目录。'),{code:'installation_config_invalid'});}
  for(const key of ['source','executable','browser'])if(saved[key]!=null&&typeof saved[key]!=='string')throw Error('Invalid installation setting: '+key);
  return {source:env.NONAME_SOURCE || saved.source,executable:env.NONAME_EXECUTABLE || (env.NONAME_SOURCE ? undefined : saved.executable),browser:env.NONAME_BROWSER || saved.browser};
}
function normalize(value){
  const root=path.resolve(value),nested=path.join(root,'resources','app');
  return !fs.existsSync(path.join(root,'noname.js'))&&fs.existsSync(path.join(nested,'noname.js'))?nested:root;
}
function source(explicit){
  const value=explicit || defaults().source;
  if(!value)throw Object.assign(Error('尚未配置游戏目录。先运行 setup --source 游戏安装目录，或传入 --source / NONAME_SOURCE。'),{code:'installation_required'});
  return normalize(value);
}
function resolveExecutable(gameSource,explicit){
  if(explicit)return path.resolve(explicit);
  const root=path.resolve(normalize(gameSource),'../..');
  return EXECUTABLE_NAMES.map(name=>path.join(root,name)).find(candidate=>fs.existsSync(candidate))||path.join(root,EXECUTABLE_NAMES[0]);
}
function save(options,file=FILE){
  if(!options.source)throw Error('setup 需要 --source 游戏安装目录或 resources/app 目录。');
  const gameSource=normalize(options.source),executable=resolveExecutable(gameSource,options.executable);
  const missing=[path.join(gameSource,'noname.js'),path.join(gameSource,'index.html'),executable].filter(p=>!fs.existsSync(p));
  if(missing.length)throw Object.assign(Error('安装目录缺少文件：'+missing.join(', ')),{code:'installation_invalid'});
  const browser=options.browser?path.resolve(options.browser):undefined;
  if(browser&&!fs.existsSync(browser))throw Error('浏览器程序不存在：'+browser);
  const value={source:gameSource,executable,...(browser?{browser}:{})};
  fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n');fs.renameSync(temp,file);
  return {ok:true,...value,configFile:file};
}
module.exports={FILE,EXECUTABLE_NAMES,defaults,source,normalize,resolveExecutable,save};
