import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,lstatSync,rmSync,renameSync,writeFileSync,readFileSync,existsSync,linkSync,unlinkSync,chmodSync,symlinkSync,constants,openSync,closeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openQuoteDirectory} from '../src/quote-directory.mjs';
function fixture(t){const base=realpathSync(mkdtempSync(join(tmpdir(),'mote-fd-public-fixture-')));chmodSync(base,0o700);const root=join(base,'root');mkdirSync(root,{mode:0o700});t.after(()=>rmSync(base,{recursive:true,force:true}));return{base,root};}
test('directory handle rejects replacement before open and unsafe leaf names',t=>{const{base,root}=fixture(t);const expected=lstatSync(root);renameSync(root,join(base,'old'));mkdirSync(root,{mode:0o700});assert.throws(()=>openQuoteDirectory(root,{expected,fixture:true}));const io=openQuoteDirectory(root,{expected:lstatSync(root),fixture:true});t.after(()=>io.close());for(const name of ['../x','/x','..','.','a/b','a\\b',''])assert.throws(()=>io.child(name));});
test('directory handle closes idempotently and rejects further operations',t=>{const{root}=fixture(t);const io=openQuoteDirectory(root,{expected:lstatSync(root),fixture:true});io.close();io.close();assert.throws(()=>io.child('x'));assert.throws(()=>io.sync());});
test('directory permission change fails closed',t=>{const{root}=fixture(t);const io=openQuoteDirectory(root,{expected:lstatSync(root),fixture:true});t.after(()=>io.close());chmodSync(root,0o770);assert.throws(()=>io.child('x'));});
test('native Linux descriptor anchors create, link, read, unlink and fsync after pathname substitution',{skip:process.platform!=='linux'},t=>{
 const{base,root}=fixture(t);const io=openQuoteDirectory(root,{expected:lstatSync(root),fixture:false});t.after(()=>io.close());assert.equal(io.nativeAnchored,true);
 const old=join(base,'old');renameSync(root,old);mkdirSync(root,{mode:0o700});
 const fd=openSync(io.child('pending'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeFileSync(fd,'PUBLIC FIXTURE');closeSync(fd);io.sync();
 linkSync(io.child('pending'),io.child('published'));assert.equal(readFileSync(io.child('published'),'utf8'),'PUBLIC FIXTURE');unlinkSync(io.child('pending'));io.sync();
 assert.equal(existsSync(join(root,'pending')),false);assert.equal(existsSync(join(root,'published')),false);assert.equal(readFileSync(join(old,'published'),'utf8'),'PUBLIC FIXTURE');
});
test('native Linux symlink leaf cannot redirect a no-follow open',{skip:process.platform!=='linux'},t=>{const{base,root}=fixture(t);const target=join(base,'outside');writeFileSync(target,'PUBLIC');symlinkSync(target,join(root,'key'));const io=openQuoteDirectory(root,{expected:lstatSync(root)});t.after(()=>io.close());assert.throws(()=>openSync(io.child('key'),constants.O_RDONLY|constants.O_NOFOLLOW));});
