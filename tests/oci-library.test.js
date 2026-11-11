const {test}=require('node:test');
const assert=require('node:assert/strict');
const {promisify}=require('node:util');
const execFile=promisify(require('node:child_process').execFile);
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {start}=require('./support/oci-stub-registry.js');
const ed25519=require('./support/ed25519.js');
const OCI_MEDIA={indexArtifact:'application/vnd.nicheknack.lamplighter.index.v1',indexLayer:'application/vnd.nicheknack.lamplighter.index.v1+json'};
// What a reader does with a registry: the index by its entries layer's media type, manifests, blobs
const reader=ref=>{
  const url=new URL(ref);const prefix=url.pathname.replace(/^\/+|\/+$/g,'');
  const get=async(path,accept)=>{const r=await fetch(`${url.origin}/v2/${path}`,{headers:accept?{accept}:{}});if(!r.ok)throw new Error(`${path}: ${r.status}`);return r;};
  const api={
    manifest:async(repo,reference)=>(await get(`${repo}/manifests/${reference}`,'application/vnd.oci.image.manifest.v1+json')).json(),
    blobText:async(repo,digest)=>(await get(`${repo}/blobs/${digest}`)).text(),
    index:async()=>{const m=await api.manifest(`${prefix}/index`,'latest');const layer=m.layers.find(l=>l.mediaType===OCI_MEDIA.indexLayer);return JSON.parse(await api.blobText(`${prefix}/index`,layer.digest));}
  };
  return api;
};

// The library index of every kind (docs/LIBRARY-OCI.md) and the edition publisher's handling of it.
// The app's own client and released readers are tested in the Lamplighter app.
const FIXTURES=path.join(__dirname,'fixtures','oci-library');
const entriesBytes=fs.readFileSync(path.join(FIXTURES,'index-v1.json'));
const vector=JSON.parse(fs.readFileSync(path.join(FIXTURES,'signature-vector.json'),'utf8'));
const library=JSON.parse(entriesBytes);
const SIGNATURE_LAYER='application/vnd.nicheknack.lamplighter.index.signature.v1+json';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

// The signed library index, its signature layer first so nothing can rely on layer order
function seedIndex(registry,bytes=entriesBytes){
  return registry.artifact('lamp/index','latest',{artifactType:OCI_MEDIA.indexArtifact,layers:[
    {mediaType:SIGNATURE_LAYER,data:JSON.stringify(vector.layer)},
    {mediaType:OCI_MEDIA.indexLayer,data:bytes}
  ]});
}

test('the entries layer is found by its media type wherever the signature layer sits',async()=>{
  const registry=await start();
  try{
    seedIndex(registry);
    const ref=`http://127.0.0.1:${registry.port}/lamp`;
    const index=await reader(ref).index();
    assert.equal(index.entries.length,library.entries.length);
    assert.deepEqual(index.definitions,library.definitions);
    const {stdout}=await execFile('python3',['scripts/oci-editions.py','catalog',ref]);
    assert.match(stdout,/matthew-henry/);
    const tags=await (await fetch(`http://127.0.0.1:${registry.port}/v2/lamp/index/tags/list`)).json();
    assert.deepEqual(tags,{name:'lamp/index',tags:['latest']});
  }finally{await registry.close();}
});

test('an edition pushed with the edition publisher keeps every other kind and the label definitions',async()=>{
  fs.mkdirSync('test-results',{recursive:true});
  const dir=fs.mkdtempSync(path.join('test-results','oci-library-'));
  const registry=await start();
  try{
    seedIndex(registry);
    const file=path.join(dir,'web.json');
    fs.writeFileSync(file,JSON.stringify({metadata:{name:'World English Bible',language:'eng',license:'Public Domain'},books:[{name:'Genesis',chapters:[{chapter:1,verses:[{verse:1,text:'In the beginning'}]}]}]}));
    const ref=`http://127.0.0.1:${registry.port}/lamp`;
    await execFile('python3',['scripts/oci-editions.py','push',ref,file]);
    const client=reader(ref);
    const index=await client.index();
    assert.equal(index.entries.length,library.entries.length+1);
    for(const entry of library.entries)assert.deepEqual(index.entries.find(e=>e.id===entry.id),entry);
    assert.deepEqual(index.definitions,library.definitions);
    // It writes no signature: a push to nk.tools must go through the library publisher (spec §10)
    const manifest=await client.manifest('lamp/index','latest');
    assert.deepEqual(manifest.layers.map(l=>l.mediaType),[OCI_MEDIA.indexLayer]);
  }finally{
    await registry.close();
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('the index signature covers every byte of the entries, by the spec\'s message and key id',async()=>{
  const publicKey=Buffer.from(vector.publicKeyHex,'hex');
  assert.equal(Buffer.from(ed25519.getPublicKey(Buffer.from(vector.seedHex,'hex'))).toString('hex'),vector.publicKeyHex);
  assert.equal(vector.keyId,sha(publicKey).slice(0,16));
  assert.equal(vector.entriesDigest,`sha256:${sha(entriesBytes)}`);
  assert.equal(vector.layer.signed,vector.entriesDigest);
  const message=digest=>new TextEncoder().encode(`lamplighter-library-index-v1\n${digest}\n`);
  assert.equal(vector.message,new TextDecoder().decode(message(vector.entriesDigest)));
  const signature=Buffer.from(vector.layer.signature,'base64url');
  assert.equal(signature.length,64);
  assert.equal(ed25519.verify(signature,message(vector.entriesDigest),publicKey),true);
  // One changed byte in the entries is another digest, and the signature no longer verifies
  const changed=Buffer.from(entriesBytes);changed[changed.length-3]^=1;
  assert.equal(ed25519.verify(signature,message(`sha256:${sha(changed)}`),publicKey),false);
  // Another key does not verify it either
  const other=ed25519.getPublicKey(Buffer.alloc(32,7));
  assert.equal(ed25519.verify(signature,message(vector.entriesDigest),other),false);
});

test('the fixture index follows the spec\'s entry rules',()=>{
  const DIRS={edition:'editions',commentary:'commentaries',confession:'confessions',study:'study'};
  const LABELS=['reformed','arminian','antinomian','lutheran','catholic','heretical','neutral','mixed'];
  assert.equal(library.schema,1);
  assert.match(library.generated,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  for(const [label,definition] of Object.entries(library.definitions)){
    assert.ok(LABELS.includes(label),label);
    assert.ok(definition.name&&definition.definition.length<=400,label);
  }
  const ids=library.entries.map(e=>e.id);
  assert.equal(new Set(ids).size,ids.length,'ids are unique across every kind');
  for(const entry of library.entries){
    const kind=entry.kind||'edition';
    assert.match(entry.id,/^[a-z0-9._-]+$/);
    for(const field of ['repo','tag','manifestDigest','size','name','language','license'])assert.ok(entry[field]!==undefined,`${entry.id} ${field}`);
    assert.match(entry.manifestDigest,/^sha256:[0-9a-f]{64}$/);
    if(DIRS[kind])assert.equal(entry.repo,`lamp/${DIRS[kind]}/${entry.id}`);
    if(kind==='edition'){assert.ok(entry.bookCount>0&&entry.revision>=1);continue;}
    for(const field of ['version','format','stance'])assert.ok(entry[field]!==undefined,`${entry.id} ${field}`);
    assert.equal(entry.tag,entry.version);
    assert.match(entry.format,/^lamplighter-[a-z-]+@\d+$/);
    assert.ok(library.definitions[entry.stance.label],`${entry.id} label defined`);
    assert.ok(entry.stance.why&&entry.stance.why.length<=300,`${entry.id} why`);
    for(const label of entry.stanceAlso||[])assert.ok(library.definitions[label],`${entry.id} ${label} defined`);
    if(entry.description)assert.ok(entry.description.length<=400,`${entry.id} description`);
    if(kind==='study')assert.ok(['cross-references','topical','dictionary'].includes(entry.studyType));
  }
  assert.ok(entriesBytes.length<=4*1024*1024);
});

// ----- O1: the library publisher, scripts/oci-library.py -----
const http=require('node:http');
const zlib=require('node:zlib');
const publisher=(...args)=>execFile('python3',['scripts/oci-library.py',...args]);
const failsWith=async(promise,pattern)=>{await assert.rejects(promise,error=>{assert.match(error.stderr||error.message,pattern);return true;});};
const sends=registry=>registry.log.filter(line=>!line.startsWith('GET'));

// A work of each kind, a library key the test lists, and the plan that publishes them
async function workspace({key=false}={}){
  fs.mkdirSync('test-results',{recursive:true});
  const dir=fs.mkdtempSync(path.join('test-results','oci-publisher-'));
  const write=(name,value)=>{fs.writeFileSync(path.join(dir,name),typeof value==='string'?value:JSON.stringify(value));return path.join(dir,name);};
  write('henry.json',{type:'commentary',name:'Test Henry',entries:[{range:{start:{book:'John',book_index:42,chapter:3,verse:16}},content:'For God so loved the world.'}]});
  write('wcf.json',{format:'lamplighter-confession',name:'Westminster (test)',chapters:[]});
  write('tsk.json',{format:'lamplighter-crossrefs',refs:{}});
  const works={
    commentary:{id:'test-henry',kind:'commentary',file:'henry.json',version:'1.0.0',name:'Henry’s Commentary (test)',language:'eng',license:'Public Domain',format:'lamplighter-commentary@1',author:'Matthew Henry',date:'1706–1714',coverage:'John',description:'Devotional exposition.',stance:{label:'reformed',why:'Presbyterian Nonconformist; Westminster theology.'}},
    confession:{id:'test-wcf',kind:'confession',file:'wcf.json',version:'1.0.0',name:'Westminster Confession (test)',language:'eng',license:'Public Domain',format:'lamplighter-confession@1',stance:{label:'reformed',why:'A Reformed confession.'}},
    study:{id:'test-tsk',kind:'study',file:'tsk.json',version:'1.0.0',name:'Treasury of Scripture Knowledge (test)',language:'eng',license:'Public Domain',format:'lamplighter-crossrefs@1',studyType:'cross-references',stance:{label:'neutral',why:'References only.'}}
  };
  const plan=(list,name='works.json')=>write(name,{publisher:'Niche-Knack Apps (test)',definitions:library.definitions,works:list});
  const space={dir,write,works,plan,cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
  if(key){
    await publisher('keygen',path.join(dir,'key'));
    space.key=JSON.parse(fs.readFileSync(path.join(dir,'key','library-key.json'),'utf8'));
    space.pem=path.join(dir,'key','library-ed25519.pem');
    space.keys=write('keys.json',{keys:[space.key]});
    space.signed=['--key',space.pem,'--keys',space.keys];
  }
  return space;
}

// The read-only tree export-static writes, served the way Caddy serves it (spec §7)
function serveStatic(root){
  return new Promise(resolve=>{
    const server=http.createServer((req,res)=>{
      const pathname=decodeURIComponent(new URL(req.url,'http://static').pathname);
      let file=path.join(root,pathname);
      if(pathname==='/v2/')file=path.join(root,'v2','index.json');
      if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);return res.end();}
      if(!file.startsWith(root)||!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.writeHead(404);return res.end();}
      const body=fs.readFileSync(file);
      const type=pathname.includes('/manifests/')?'application/vnd.oci.image.manifest.v1+json':pathname.endsWith('/tags/list')||pathname==='/v2/'?'application/json':'application/octet-stream';
      res.writeHead(200,{'content-type':type,...(pathname.includes('/manifests/')?{'docker-content-digest':`sha256:${sha(body)}`}:{})});
      res.end(req.method==='HEAD'?undefined:body);
    });
    server.listen(0,'127.0.0.1',()=>resolve({port:server.address().port,close:()=>new Promise(r=>{server.closeAllConnections?.();server.close(r);})}));
  });
}

async function signatureOf(client){
  const manifest=await client.manifest('lamp/index','latest');
  const entries=manifest.layers.find(l=>l.mediaType===OCI_MEDIA.indexLayer);
  const layer=manifest.layers.find(l=>l.mediaType===SIGNATURE_LAYER);
  return {entries,signature:layer?JSON.parse(await client.blobText('lamp/index',layer.digest)):null};
}

test('the publisher mints a library key once and never overwrites it',async()=>{
  const space=await workspace({key:true});
  try{
    assert.equal(space.key.keyId,sha(Buffer.from(space.key.publicKeyHex,'hex')).slice(0,16));
    assert.equal(fs.statSync(space.pem).mode&0o777,0o600);
    await failsWith(publisher('keygen',path.join(space.dir,'key')),/never overwritten/);
    // The shipped key list holds the real library key, and nothing signs with a key the app doesn't carry
    const shipped=JSON.parse(fs.readFileSync('library/library-keys.json','utf8'));
    assert.deepEqual(shipped.keys.map(k=>k.keyId),['8f57a68d449d468f']);
    assert.equal(shipped.keys[0].keyId,sha(Buffer.from(shipped.keys[0].publicKeyHex,'hex')).slice(0,16));
    const registry=await start();
    try{await failsWith(publisher('publish',`http://127.0.0.1:${registry.port}/lamp`,space.plan([space.works.commentary]),'--key',space.pem),/not in the key list the app ships/);assert.deepEqual(sends(registry),[]);}
    finally{await registry.close();}
  }finally{space.cleanup();}
});

test('publish checks every work before it sends anything',async()=>{
  const space=await workspace();
  const registry=await start();
  try{
    const ref=`http://127.0.0.1:${registry.port}/lamp`;
    const emoji='\u{1F4D6}';
    const cases=[
      [{...space.works.study,description:'x'.repeat(401)},/at most 400/],
      // The app counts UTF-16 units: 399 characters with one emoji are 400 there, 400 with one are 401
      [{...space.works.commentary,id:'test-two',description:'x'.repeat(398)+emoji+'x'},/at most 400/],
      [{...space.works.study,stance:{label:'reformed',why:'x'.repeat(301)}},/at most 300/],
      [{...space.works.study,stance:{label:'calvinist',why:'Not a label.'}},/label the index defines/],
      [{...space.works.study,studyType:undefined},/studyType/],
      [{...space.works.commentary,id:'test-two',file:'wcf.json'},/not a commentary the app imports/],
      [{...space.works.commentary,id:'test-two',format:'lamplighter-notes@1'},/lamplighter-commentary@1/],
      [{...space.works.study,id:'Bad Id'},/lowercase/],
      [{...space.works.study,kind:'edition'},/oci-editions.py/],
      [{...space.works.study,version:'1.0'},/1\.0\.0/],
      [{...space.works.study,version:'١.٠.٠'},/1\.0\.0/],
      [{...space.works.study,name:7},/name is text/],
      [{...space.works.study,colour:'red'},/unknown field/],
      // Confessions and study works wait for the app release that shares them
      [space.works.confession,/not a format the app shares Lamplighter to Lamplighter yet/],
      [space.works.study,/not a format the app shares Lamplighter to Lamplighter yet/]
    ];
    for(const [work,pattern] of cases)await failsWith(publisher('publish',ref,space.plan([space.works.commentary,work]),...(pattern.source.includes('shares')?[]:['--draft-format'])),pattern);
    const ok=space.plan([space.works.commentary,{...space.works.commentary,id:'test-two',description:'x'.repeat(398)+emoji}],'ok.json');
    // A work too large for one Lamplighter-to-Lamplighter share is refused (64 MiB, re-serialized)
    space.write('huge.json',{type:'commentary',name:'Huge',entries:[{range:{start:{book_index:0,chapter:1,verse:1}},content:'x'.repeat(64*1024*1024)}]});
    await failsWith(publisher('publish',ref,space.plan([space.works.commentary,{...space.works.commentary,id:'test-huge',file:'huge.json'}])),/64 MiB one Lamplighter-to-Lamplighter share carries/);
    fs.rmSync(path.join(space.dir,'huge.json'));
    // The good commentary listed first was never sent
    assert.deepEqual(sends(registry),[]);
    await publisher('publish',ref,ok);
    assert.ok(sends(registry).length>0);
  }finally{await registry.close();space.cleanup();}
});

test('publish adds every kind beside the editions and signs the index',async()=>{
  const space=await workspace({key:true});
  const registry=await start();
  try{
    const ref=`http://127.0.0.1:${registry.port}/lamp`;
    const edition=space.write('web.json',{metadata:{name:'World English Bible',language:'eng',license:'Public Domain'},books:[{name:'Genesis',chapters:[{chapter:1,verses:[{verse:1,text:'In the beginning'}]}]}]});
    await execFile('python3',['scripts/oci-editions.py','push',ref,edition]);
    const plan=space.plan(Object.values(space.works));
    // The edition no signature covers is not signed over unless it was checked
    await failsWith(publisher('publish',ref,plan,'--draft-format',...space.signed),/no valid signature covers: web/);
    const {stdout}=await publisher('publish',ref,plan,'--draft-format','--adopt-unverified',...space.signed);
    assert.match(stdout,new RegExp(`lists 4 entries, signed by ${space.key.keyId}`));
    const client=reader(ref);
    const index=await client.index();
    assert.deepEqual(index.entries.map(e=>`${e.kind}:${e.id}`).sort(),['commentary:test-henry','confession:test-wcf','edition:web','study:test-tsk']);
    assert.deepEqual(index.definitions,library.definitions);
    const henry=index.entries.find(e=>e.id==='test-henry');
    assert.equal(henry.repo,'lamp/commentaries/test-henry');
    assert.equal(henry.tag,'1.0.0');
    assert.equal(henry.compressed,true);
    assert.equal(henry.date,'1706–1714');
    // The work's manifest: its kind's artifact type, its entry as config, one gzip layer of the exact file
    const manifest=await client.manifest(henry.repo,henry.manifestDigest);
    assert.equal(manifest.artifactType,'application/vnd.nicheknack.lamplighter.commentary.v1');
    const config=JSON.parse(await client.blobText(henry.repo,manifest.config.digest));
    const {repo,tag,manifestDigest,size,...facts}=henry;
    assert.deepEqual(config,facts);
    assert.equal(manifest.layers[0].mediaType,'application/vnd.nicheknack.lamplighter.commentary.v1+json+gzip');
    const stored=registry.blobs.get(`${henry.repo}@${manifest.layers[0].digest}`);
    assert.equal(stored.length,henry.size);
    assert.deepEqual(zlib.gunzipSync(stored),fs.readFileSync(path.join(space.dir,'henry.json')));
    // The signature covers the entries layer, by the spec's message, with the minted key, strictly
      const {entries,signature}=await signatureOf(client);
    assert.equal(signature.keyId,space.key.keyId);
    assert.equal(signature.signed,entries.digest);
    const message=new TextEncoder().encode(`lamplighter-library-index-v1\n${entries.digest}\n`);
    assert.equal(ed25519.verify(Buffer.from(signature.signature,'base64url'),message,Buffer.from(space.key.publicKeyHex,'hex')),true);
    const catalog=await publisher('catalog',ref,'--keys',space.keys,'--require-signed');
    assert.match(catalog.stdout,/commentary +test-henry +Henry’s Commentary \(test\) · Matthew Henry · 1706–1714 · John · Reformed/);
    assert.match(catalog.stdout,new RegExp(`4 entries, generated .*, signed by ${space.key.keyId}`));
    // Publishing without the key would strip the signature: refused unless asked for
    await failsWith(publisher('publish',ref,space.plan([space.works.commentary]),'--keys',space.keys),/would leave it unsigned/);
    // An edition pushed afterwards keeps every work, and leaves the index unsigned
    await execFile('python3',['scripts/oci-editions.py','push',ref,edition,'--tag','main.r2']);
    assert.equal((await client.index()).entries.length,4);
    assert.match((await publisher('catalog',ref,'--keys',space.keys)).stdout,/unsigned/);
    await failsWith(publisher('catalog',ref,'--keys',space.keys,'--require-signed'),/--require-signed/);
    await failsWith(publisher('catalog',ref,'--keys',path.join(space.dir,'missing.json')),/does not exist/);
  }finally{await registry.close();space.cleanup();}
});

test('a published version never changes, generated only grows, and nothing is sent until everything is checked',async()=>{
  const space=await workspace();
  const registry=await start();
  try{
    const ref=`http://127.0.0.1:${registry.port}/lamp`;
    const plan=space.plan([space.works.commentary]);
    await publisher('publish',ref,plan);
    const first=await reader(ref).index();
    await new Promise(r=>setTimeout(r,1100));
    const again=await publisher('publish',ref,plan);
    assert.match(again.stdout,/unchanged lamp\/commentaries\/test-henry:1\.0\.0/);
    const second=await reader(ref).index();
    assert.equal(second.entries[0].manifestDigest,first.entries[0].manifestDigest);
    assert.ok(second.generated>first.generated,'generated grows');
    // The same content packed by another gzip (another Python or zlib build) is still the same version
    const repo='lamp/commentaries/test-henry';
    const manifest=JSON.parse(registry.manifests.get(`${repo}:1.0.0`));
    const config=registry.blobs.get(`${repo}@${manifest.config.digest}`);
    const repacked=registry.artifact(repo,'1.0.0',{artifactType:manifest.artifactType,config:{mediaType:manifest.config.mediaType,data:config},
      layers:[{mediaType:manifest.layers[0].mediaType,data:zlib.gzipSync(fs.readFileSync(path.join(space.dir,'henry.json')),{level:1})}]});
    const kept=await publisher('publish',ref,plan);
    assert.match(kept.stdout,/unchanged/);
    assert.equal((await reader(ref).index()).entries[0].manifestDigest,repacked);
    // New content under a published version is refused, and a new work listed before it is not sent either
    space.write('henry.json',{type:'commentary',name:'Test Henry',entries:[{range:{start:{book_index:42,chapter:3,verse:17}},content:'Changed.'}]});
    const before=sends(registry).length;
    await failsWith(publisher('publish',ref,space.plan([{...space.works.commentary,id:'test-new'},space.works.commentary])),/already published with other content/);
    assert.equal(sends(registry).length,before);
    await publisher('publish',ref,space.plan([{...space.works.commentary,version:'1.1.0'}]));
    const third=await reader(ref).index();
    assert.equal(third.entries[0].tag,'1.1.0');
    const tags=await (await fetch(`http://127.0.0.1:${registry.port}/v2/${repo}/tags/list`)).json();
    assert.deepEqual(tags.tags.sort(),['1.0.0','1.1.0']);
    // The same id as another kind is refused
    await failsWith(publisher('publish',ref,space.plan([{...space.works.study,id:'test-henry'}]),'--draft-format'),/ids are unique across kinds/);
    // An index that claims a time in the future is refused before anything is sent
    const future={...third,generated:'9999-12-31T23:59:59Z'};
    registry.artifact('lamp/index','latest',{artifactType:OCI_MEDIA.indexArtifact,layers:[{mediaType:OCI_MEDIA.indexLayer,data:JSON.stringify(future)}]});
    const count=sends(registry).length;
    await failsWith(publisher('publish',ref,space.plan([{...space.works.commentary,id:'test-later',version:'1.0.0'}])),/in the future/);
    assert.equal(sends(registry).length,count);
  }finally{await registry.close();space.cleanup();}
});

test('pull returns the exact work, and export-static writes a tree the app reads as a registry',async()=>{
  const space=await workspace({key:true});
  const registry=await start();
  let tree=null;
  try{
    const ref=`http://127.0.0.1:${registry.port}/lamp`;
    await publisher('publish',ref,space.plan(Object.values(space.works)),'--draft-format',...space.signed);
    const out=path.join(space.dir,'pulled.json');
    await publisher('pull',ref,'test-henry','--out',out,'--keys',space.keys,'--require-signed');
    assert.deepEqual(fs.readFileSync(out),fs.readFileSync(path.join(space.dir,'henry.json')));
    const root=path.resolve(space.dir,'static');
    // Formats the app doesn't share yet never reach a static tree without --draft-format
    await failsWith(publisher('export-static',ref,root,'--keys',space.keys),/not a format the app shares/);
    const exported=await publisher('export-static',ref,root,'--keys',space.keys,'--require-signed','--draft-format');
    assert.match(exported.stdout,new RegExp(`exported 3 entries \\(signed by ${space.key.keyId}\\)`));
    await failsWith(publisher('export-static',ref,root,'--draft-format'),/not empty/);
    tree=await serveStatic(root);
    const staticRef=`http://127.0.0.1:${tree.port}/lamp`;
    const fromTree=await reader(staticRef).index();
    assert.deepEqual(fromTree,await reader(ref).index());
    assert.match((await publisher('catalog',staticRef,'--keys',space.keys)).stdout,new RegExp(`3 entries, .*signed by ${space.key.keyId}`));
    const again=path.join(space.dir,'pulled-static.json');
    await publisher('pull',staticRef,'test-wcf','--out',again,'--keys',space.keys);
    assert.deepEqual(fs.readFileSync(again),fs.readFileSync(path.join(space.dir,'wcf.json')));
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${tree.port}/v2/`)).json(),{});
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${tree.port}/v2/lamp/study/test-tsk/tags/list`)).json(),{name:'lamp/study/test-tsk',tags:['1.0.0']});
    // A key the list doesn't carry, and a changed signature, are both reported
    assert.match((await publisher('catalog',staticRef,'--keys',space.write('other.json',{keys:[]}))).stdout,/a key this list does not carry/);
    const manifest=JSON.parse(fs.readFileSync(path.join(root,'v2/lamp/index/manifests/latest'),'utf8'));
    const signatureFile=path.join(root,'v2/lamp/index/blobs',manifest.layers.find(l=>l.mediaType===SIGNATURE_LAYER).digest);
    const signature=JSON.parse(fs.readFileSync(signatureFile,'utf8'));
    const bytes=Buffer.from(signature.signature,'base64url');bytes[0]^=1;
    const forged=Buffer.from(JSON.stringify({...signature,signature:bytes.toString('base64url')}));
    fs.rmSync(signatureFile);
    const forgedDigest=`sha256:${sha(forged)}`;
    fs.writeFileSync(path.join(root,'v2/lamp/index/blobs',forgedDigest),forged);
    manifest.layers=manifest.layers.map(l=>l.mediaType===SIGNATURE_LAYER?{...l,digest:forgedDigest,size:forged.length}:l);
    fs.writeFileSync(path.join(root,'v2/lamp/index/manifests/latest'),JSON.stringify(manifest));
    await failsWith(publisher('catalog',staticRef,'--keys',space.keys),/BAD SIGNATURE/);
    await failsWith(publisher('pull',staticRef,'test-henry','--out',out,'--keys',space.keys),/BAD SIGNATURE.*nothing pulled/);
  }finally{await tree?.close();await registry.close();space.cleanup();}
});

test('a hostile index cannot make export-static write outside its directory, nor crash catalog',async()=>{
  const space=await workspace();
  const registry=await start();
  try{
    const ref=`http://127.0.0.1:${registry.port}/lamp`;
    await publisher('publish',ref,space.plan([space.works.commentary]));
    const index=await reader(ref).index();
    const seed=entries=>registry.artifact('lamp/index','latest',{artifactType:OCI_MEDIA.indexArtifact,layers:[{mediaType:OCI_MEDIA.indexLayer,data:JSON.stringify({...index,entries})}]});
    const henry=index.entries[0];
    const parent=path.resolve(space.dir);
    for(const [entries,pattern] of [
      [[{...henry,repo:'lamp/../../escaped'}],/unsafe or malformed/],
      [[{...henry,repo:'/tmp/escaped'}],/unsafe or malformed/],
      [[{...henry,repo:'other/commentaries/x'}],/unsafe or malformed/],
      [[{...henry,tag:'../../../escaped.json'}],/unsafe or malformed/],
      [[{...henry,manifestDigest:'1.0.0'}],/unsafe or malformed/]
    ]){
      seed(entries);
      await failsWith(publisher('export-static',ref,path.join(space.dir,'out-'+Math.random().toString(36).slice(2))),pattern);
    }
    // A tag the registry lists is checked too
    seed([henry]);
    registry.manifests.set(`${henry.repo}:../../../../escaped.json`,registry.manifests.get(`${henry.repo}:1.0.0`));
    await failsWith(publisher('export-static',ref,path.join(space.dir,'out-tags')),/not a valid OCI tag/);
    assert.deepEqual(fs.readdirSync(parent).filter(n=>n.includes('escaped')),[]);
    assert.equal(fs.existsSync('/tmp/escaped'),false);
    // A malformed entry is reported, not a traceback
    seed([henry,{name:'no id'}]);
    const failure=await publisher('catalog',ref).catch(error=>error);
    assert.match(failure.stdout,/malformed/);
    assert.match(failure.stderr,/1 malformed entries/);
    assert.doesNotMatch(failure.stderr,/Traceback/);
  }finally{await registry.close();space.cleanup();}
});

