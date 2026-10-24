// Preserve SVGs populated by the original lesson's own interactive drawing code.
// jsdom runs locally with no external resources enabled.
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),value=name=>args[args.indexOf(name)+1];
if(!args.includes('--jsdom'))throw Error('Pass --jsdom <absolute jsdom module directory>.');
const {JSDOM}=require(path.resolve(value('--jsdom')));
const root=path.resolve(__dirname,'..'),file='2026年11月号_発展演習・学力コンテスト_思考力を育てる解説.html';
let source=fs.readFileSync(path.join(root,'math',file),'utf8');
source=source.replace(/<script[^>]*id="recorded-lecture-(?:data|audio-source[^"]*|runtime)"[^>]*>[\s\S]*?<\/script>\s*/g,'');
const dom=new JSDOM(source,{runScripts:'dangerously',url:'https://iwslatojp29.github.io/math-app/math/'+encodeURIComponent(file),pretendToBeVisual:true,beforeParse(window){window.matchMedia=()=>({matches:true,addEventListener(){}});window.print=()=>{};}});
const result={};
for(const article of dom.window.document.querySelectorAll('article')){
 const figures=[...article.querySelectorAll('.visual svg')];if(figures.length)result[article.id]=figures.map(svg=>svg.outerHTML);
}
const out=path.join(root,'automation/lecture-diagrams');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,file.replace('.html','.json')),JSON.stringify(result));
console.log('Saved initialized original diagrams for '+Object.keys(result).length+' questions.');dom.window.close();
