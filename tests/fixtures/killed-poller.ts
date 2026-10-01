import {runProcess} from '../../wsl-worker/providers.ts';
import {dirname} from 'node:path';
const marker=process.argv[2];
const deadlineNs=process.hrtime.bigint()+1000000000n;
await new Promise(r=>setTimeout(r,300)); // delayed claim/preparation must consume this same budget
// Synthetic process only; no provider/network call. The poller is killed by its test.
await runProcess(process.execPath,['-e','require("fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},100)',marker],'',dirname(marker),new AbortController().signal,60000,deadlineNs);
