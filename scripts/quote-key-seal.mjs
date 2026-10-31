import { pathToFileURL } from 'node:url';
import { parseJson } from '../src/json.mjs';
import { KEYCHAIN_ACTIVATION, sealKeychainQuoteForImport } from '../src/keychain-custody.mjs';

// Stdin contains only the receiver's PUBLIC challenge. No key is accepted on
// stdin, argv, env or disk. Native Q bytes travel only through the private pipes
// of the pinned Keychain helper and leave this command only as AEAD ciphertext.
export function quoteSealArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 9 || argv[0] !== '--activate-native-keychain-v1') throw Error('SEAL_ARGUMENTS');
  const expected = ['--helper','--helper-sha256','--destination-hash','--challenge-hash'];
  const values = {};
  for (let i=0;i<expected.length;i++) {
    if (argv[1+2*i] !== expected[i] || typeof argv[2+2*i] !== 'string') throw Error('SEAL_ARGUMENTS');
    values[expected[i]] = argv[2+2*i];
  }
  if (!values['--helper'].startsWith('/') || values['--helper'].includes('\0') || values['--helper'].length>4096
    || !expected.slice(1).every(key=>/^[a-f0-9]{64}$/.test(values[key]))) throw Error('SEAL_ARGUMENTS');
  return Object.freeze({ role:'quote-backup',chainId:11155111,activation:KEYCHAIN_ACTIVATION,
    helperPath:values['--helper'],expectedHelperSha256:values['--helper-sha256'],
    expectedDestinationHash:values['--destination-hash'],expectedChallengeHash:values['--challenge-hash'] });
}
async function readPublicChallenge(stream) {
  let input='';
  for await (const chunk of stream) {
    input+=chunk.toString('utf8');
    if(Buffer.byteLength(input)>8192)throw Error('SEAL_INPUT');
  }
  return parseJson(input);
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const timer=setTimeout(()=>{process.stderr.write('{"error":"QUOTE_SEAL_FAILED_CLOSED"}\n');process.exit(1);},15000);
  try {
    const options=quoteSealArguments(process.argv.slice(2));
    const capsule=await sealKeychainQuoteForImport({...options,challenge:await readPublicChallenge(process.stdin)});
    process.stdout.write(JSON.stringify(capsule)+'\n');
  } catch { process.stderr.write('{"error":"QUOTE_SEAL_FAILED_CLOSED"}\n');process.exitCode=1; }
  finally {clearTimeout(timer);}
}
