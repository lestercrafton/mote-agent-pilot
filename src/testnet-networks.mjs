// Explicit testnet allowlist. No caller-defined endpoints or arbitrary EVM IDs.
// Primary references checked 2026-10-30:
// https://docs.base.org/get-started/connect-to-base
// https://github.com/eth-clients/sepolia
// https://raw.githubusercontent.com/ethereum/go-ethereum/master/params/config.go
// https://ethereum.publicnode.com/?sepolia
// PublicNode is a third-party RPC operator, not an Ethereum consensus proof.
export const BASE_SEPOLIA = Object.freeze({
  chainId: 84532, chainIdHex: '0x14a34', slug: 'base-sepolia',
  protocol: 'mote-base-sepolia-test-v1', configSchema: 'mote-base-sepolia-chain-config-v1',
  planSchema: 'mote-base-sepolia-deployment-plan-v1', rpcUrl: 'https://sepolia.base.org',
  feeModel: 'op-stack', genesisHash: null,
  gasPriceOracle: '0x420000000000000000000000000000000000000F',
});
export const ETHEREUM_SEPOLIA = Object.freeze({
  chainId: 11155111, chainIdHex: '0xaa36a7', slug: 'ethereum-sepolia',
  protocol: 'mote-ethereum-sepolia-test-v1', configSchema: 'mote-ethereum-sepolia-chain-config-v1',
  planSchema: 'mote-ethereum-sepolia-deployment-plan-v1', rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
  feeModel: 'ethereum-eip1559',
  genesisHash: '0x25a5cc106eea7138acab33231d7160d69cb777ee0c2c553fcddf5138993e6dd9',
});
export function getTestnetNetwork(chainId) {
  if (chainId === BASE_SEPOLIA.chainId) return BASE_SEPOLIA;
  if (chainId === ETHEREUM_SEPOLIA.chainId) return ETHEREUM_SEPOLIA;
  const error = new Error('Only explicitly pinned Base Sepolia 84532 and Ethereum Sepolia 11155111 are supported');
  error.code = 'NETWORK_DENIED'; throw error;
}
