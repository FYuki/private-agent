import { realpathSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export type SandboxConfig={codexPackage:string;authFile:string;dependencies:string};
export const toolPermissions=(role:'plan'|'edit')=>['-c','default_permissions="development"','-c',`permissions.development.filesystem={"/"="read","/workspace"="${role==='edit'?'write':'read'}","/tmp"="write","/home/runner/.codex"="deny","/proc"="deny"}`,'-c','permissions.development.network.enabled=false'];
/** 許可済みCLIと専用worktree以外のHOME/credentialsを見せない。pathは管理設定だけから受け取る。 */
export function sandboxArgs(config:SandboxConfig,worktree:string,mode:'plan'|'edit'|'test',command:string[]):string[]{
 for(const path of [worktree,config.codexPackage,config.dependencies,config.authFile])if(!isAbsolute(path)||realpathSync(path)!==path)throw new Error('untrusted_sandbox_path');
 if(!lstatSync(worktree).isDirectory()||!lstatSync(config.authFile).isFile())throw new Error('invalid_sandbox_configuration');
 const args=['--die-with-parent','--new-session','--unshare-user','--unshare-pid','--unshare-ipc','--unshare-uts','--cap-drop','ALL','--clearenv',
  '--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64',
  '--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/home/runner','--dir','/home/runner/.codex',
  '--ro-bind',config.codexPackage,'/opt/codex',mode==='plan'?'--ro-bind':'--bind',worktree,'/workspace',
  '--ro-bind','/dev/null','/workspace/.git','--ro-bind',config.dependencies,'/workspace/node_modules',
  '--setenv','HOME','/home/runner','--setenv','CODEX_HOME','/home/runner/.codex','--setenv','PATH','/usr/bin:/bin',
  '--setenv','LANG','C.UTF-8','--setenv','CI','true','--chdir','/workspace'];
 if(mode==='test')args.push('--unshare-net');
 else args.push('--ro-bind',config.authFile,'/home/runner/.codex/auth.json','--ro-bind','/etc/ssl','/etc/ssl','--ro-bind','/etc/resolv.conf','/etc/resolv.conf','--ro-bind','/etc/hosts','/etc/hosts');
 return [...args,'--',...command];
}

/** 別development種別だけで編集を許可する。CLI子コマンドのnetworkはworkspace sandboxで拒否する。 */
export function codexCommand(role:'plan'|'edit'):string[]{
 return ['/usr/bin/node','/opt/codex/bin/codex.js','exec','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--ephemeral',...toolPermissions(role),'--model','gpt-6-luna','--json',
 '-c','forced_login_method="chatgpt"','-c','approval_policy="never"','-c','project_doc_max_bytes=0','-c','web_search="disabled"',
 '-c','sandbox_workspace_write.network_access=false','-c','features.apps=false','-c','features.skills=false','-c','features.hooks=false','-c','features.multi_agent=false','-c','model_reasoning_effort="low"',
 ...(role==='plan'?['-c','features.shell_tool=false','-c','features.unified_exec=false','-c','features.apply_patch_freeform=false']:[]),'-'];
}
