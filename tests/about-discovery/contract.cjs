'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),{test}=require('node:test'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/\r\n/g,'\n'),m=require('./manifest.json');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
test('original gameplay, layout, credits and controls are byte-preserved outside the About block',()=>assert.equal(hash(html.replace(/<!-- tront-about:start -->[\s\S]*?<!-- tront-about:end -->/,'')),m.game));
test('every original About paragraph, credit, related description and link remains verbatim',()=>assert.equal(hash(html.match(/<div class="tront-about-original">([\s\S]*?)<\/div>/)[1]),m.original));
test('vendors the exact user-approved shared component',()=>{for(const type of ['css','js'])assert.equal(hash(html.match(new RegExp('<'+(type==='css'?'style':'script')+' data-tront-discovery-'+type+'>\\n([\\s\\S]*?)<\\/'))[1]),m[type]);});
test('component and scoped adapter parse, disclosure begins closed',()=>{const block=html.match(/<!-- tront-about:start -->[\s\S]*?<!-- tront-about:end -->/)[0];for(const script of block.matchAll(/<script(?! type="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);assert.match(block,/<details class="tront-about" id="trontAbout">/);assert.doesNotMatch(block,/<video|<source|autoplay=/);});
