// sui-navi-query.mjs — ESM script to query Sui NAVI Protocol
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';

const client = new SuiClient({ url: getFullnodeUrl('mainnet') });

// NAVI Protocol storage object (from docs)
const NAVI_STORAGE = '0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fd';
const SUI_TYPE = '0x2::sui::SUI';

async function main() {
  console.error('=== Sui NAVI Protocol Query ===\n');
  
  // Get current checkpoint
  const cp = await client.getLatestCheckpointSequenceNumber();
  console.error('Checkpoint: ' + cp);
  
  // Query NAVI storage object
  try {
    const obj = await client.getObject({ id: NAVI_STORAGE, options: { showContent: true } });
    const content = obj.data?.content;
    if (content && content.dataType === 'moveObject') {
      console.error('NAVI Storage fields:');
      const fields = content.fields || {};
      Object.keys(fields).slice(0, 15).forEach(k => {
        const v = fields[k];
        const valStr = typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v).slice(0, 60);
        console.error(`  ${k}: ${valStr}`);
      });
    } else {
      console.error('NAVI object type: ' + (content?.dataType || 'unknown'));
    }
  } catch (e) {
    console.error('NAVI storage query failed: ' + e.message.slice(0, 100));
  }
  
  // Query total SUI supply
  const supply = await client.getTotalSupply({ coinType: SUI_TYPE });
  console.error('\nSUI supply: ' + (Number(supply.value) / 1e9).toFixed(2) + ' SUI');
  
  console.error('\nDone.');
}

main().catch(e => console.error(e.message));
