import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// @ts-ignore CLI wrapper intentionally has no third-party dependencies.
import {ownedClone,watchProviderArgs} from '../development/watch-codex-wrapper.mjs';
test('provider ownership binds SDK cwd to one exact running task and isolates control metadata',async()=>{
 const root=await mkdtemp(join(tmpdir(),'watch-wrapper-')),clones=join(root,'clones'),clone=join(clones,'task');await mkdir(clones);await mkdir(clone);await mkdir(join(clone,'.takt'));
 const policy={clones,taskName:'task',marker:'PA:fixture',workflow:'default'},task={name:'task',status:'running',summary:'PA:fixture',workflow:'default',worktreePath:clone,runSlug:'run-1'};
 const argv=['exec','--cd',clone];assert.deepEqual(ownedClone(argv,policy,[task]).mapped,['exec','--cd','/workspace']);
 for(const changed of [{status:'completed'},{name:'foreign'},{summary:'foreign'},{workflow:'simple'},{runSlug:null},{worktreePath:root}])assert.throws(()=>ownedClone(argv,policy,[{...task,...changed}]));
 assert.throws(()=>ownedClone(argv,policy,[task,task]));assert.throws(()=>ownedClone(['exec'],policy,[task]));assert.throws(()=>ownedClone([...argv,'--cd',clone],policy,[task]));
 const link=join(clones,'link');await symlink(clone,link);assert.throws(()=>ownedClone(['exec','--cd',link],policy,[{...task,worktreePath:link}]));
 const args=watchProviderArgs(clone,['exec'],policy);assert.ok(args.includes('--unshare-pid'));assert.ok(args.includes('/workspace/.git'));assert.ok(args.includes('/workspace/.takt'));assert.ok(!args.includes(root));assert.ok(!args.includes('/run-private'));
});
