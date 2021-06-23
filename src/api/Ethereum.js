// @flow
import URL from "url";
import invariant from "invariant";
import { BigNumber } from "bignumber.js";
import * as zksync from "zksync";
import { LedgerAPINotAvailable } from "@ledgerhq/errors";
import JSONBigNumber from "../JSONBigNumber";
import type { CryptoCurrency } from "../types";
import type { EthereumGasLimitRequest } from "../families/ethereum/types";
import network from "../network";
import { blockchainBaseURL } from "./Ledger";
import { FeeEstimationFailed } from "../errors";
import { makeLRUCache } from "../cache";

export type Block = { height: BigNumber }; // TODO more fields actually

export type Tx = {
  hash: string,
  status?: BigNumber, // 0: fail, 1: success
  received_at?: string,
  nonce: string,
  value: BigNumber,
  gas: BigNumber,
  gas_price: BigNumber,
  from: string,
  to: string,
  cumulative_gas_used?: BigNumber,
  gas_used?: BigNumber,
  transfer_events?: {
    list: Array<{
      contract: string,
      from: string,
      to: string,
      count: BigNumber,
      decimal?: number,
      symbol?: string,
    }>,
    truncated: boolean,
  },
  actions?: Array<{
    from: string,
    to: string,
    value: BigNumber,
    gas?: BigNumber,
    gas_used?: BigNumber,
  }>,
  block?: {
    hash: string,
    height: BigNumber,
    time: string,
  },
};

export type ERC20BalancesInput = Array<{
  address: string,
  contract: string,
}>;

export type ERC20BalanceOutput = Array<{
  address: string,
  contract: string,
  balance: BigNumber,
}>;

export type API = {
  getTransactions: (
    address: string,
    block_hash: ?string,
    batch_size?: number
  ) => Promise<{
    truncated: boolean,
    txs: Tx[],
  }>,
  getCurrentBlock: () => Promise<Block>,
  getAccountNonce: (address: string) => Promise<number>,
  broadcastTransaction: (signedTransaction: string) => Promise<string>,
  getERC20Balances: (input: ERC20BalancesInput) => Promise<ERC20BalanceOutput>,
  getAccountBalance: (address: string) => Promise<BigNumber>,
  roughlyEstimateGasLimit: (address: string) => Promise<BigNumber>,
  getERC20ApprovalsPerContract: (
    owner: string,
    contract: string
  ) => Promise<Array<{ sender: string, value: string }>>,
  getDryRunGasLimit: (
    address: string,
    request: EthereumGasLimitRequest
  ) => Promise<BigNumber>,
  getGasTrackerBarometer: () => Promise<{
    low: BigNumber,
    medium: BigNumber,
    high: BigNumber,
  }>,
};

export const apiForCurrency = (currency: CryptoCurrency): API => {
  // Hardcoded zkSync mainnet REST API.
  const rollupBaseURL = "https://api.zksync.io/api/v0.1";
  const ethBaseURL = blockchainBaseURL(currency);

  const defaultGas = new BigNumber(500);

  if (!ethBaseURL) {
    throw new LedgerAPINotAvailable(`LedgerAPINotAvailable ${currency.id}`, {
      currencyName: currency.name,
    });
  }
  return {
    async getBatchedTransactions(address, limit, offset): Tx[] {
      let { data } = await network({
        method: "GET",
        url: URL.format({
          pathname: `${rollupBaseURL}/account/${address}/history/${offset}/${limit}`,
        }),
        transformResponse: JSONBigNumber.parse,
      });

      return data.map(function (txMeta) {
        const type = txMeta.tx.type;
        const nonce = (txMeta.tx.nonce || 0).toString(16);

        // tx_id example: "17970,295"
        const blockHeight = new BigNumber(txMeta.tx_id.split(",")[0]);
        const blockTime = txMeta.created_at;

        const { to, amount } =
          type === "Deposit" ? txMeta.tx.priority_op : txMeta.tx;

        const from =
          type === "Deposit"
            ? "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
            : // magic address to prevent self-transfer operations.
              txMeta.tx.from;

        const hash =
          type === "Transfer" ? "0x" + txMeta.hash.split(":")[1] : txMeta.hash;

        return {
          hash,
          from,
          to,
          status: new BigNumber(txMeta.success ? 1 : 0),
          received_at: blockTime,
          nonce: `0x0${nonce}`,
          value: new BigNumber(amount),
          gas: defaultGas,
          gas_price: new BigNumber(txMeta.tx.fee || 0).div(defaultGas),
          block: {
            height: blockHeight,
            time: blockTime,
            hash: "0x0",
          },
          confirmations: blockHeight,
          cumulative_gas_used: defaultGas,
          gas_used: defaultGas,
        };
      });
    },

    async getTransactionsRollup(address, block_hash) {
      let txs = [];
      if (block_hash) {
        return {
          truncated: false,
          txs,
        };
      }

      const limit = 100;
      for (let offset = 0; ; offset += limit) {
        const txBatch = await this.getBatchedTransactions(
          address,
          limit,
          offset
        );
        txs = [...txs, ...txBatch];

        if (txBatch.length === 0) {
          break;
        }
      }

      return {
        truncated: false,
        txs,
      };
    },

    async getTransactions(address, block_hash, batch_size = 2000) {
      const syncHTTPProvider = await zksync.getDefaultProvider("mainnet");

      const accountState = await syncHTTPProvider.getState(address);
      if (!accountState.id) {
        return await this.getTransactionsEthereum(
          address,
          block_hash,
          batch_size
        );
      }

      return await this.getTransactionsRollup(address, block_hash);
    },

    async getTransactionsEthereum(address, block_hash, batch_size = 2000) {
      let { data } = await network({
        method: "GET",
        url: URL.format({
          pathname: `${ethBaseURL}/addresses/${address}/transactions`,
          query: {
            batch_size,
            noinput: true,
            no_token: true,
            block_hash,
          },
        }),
        transformResponse: JSONBigNumber.parse,
      });
      // v3 have a bug that still includes the tx of the paginated block_hash, we're cleaning it up
      if (block_hash) {
        data = {
          ...data,
          txs: data.txs.filter(
            (tx) => !tx.block || tx.block.hash !== block_hash
          ),
        };
      }

      return data;
    },

    async getCurrentBlock(): Block {
      const { data } = await network({
        method: "GET",
        url: `${rollupBaseURL}/blocks`,
        query: {
          limit: 1,
        },
        transformResponse: JSONBigNumber.parse,
      });

      const rawBlock = data[0];
      return {
        ...rawBlock,
        height: rawBlock.block_number,
      };
    },

    async getAccountNonce(address) {
      const syncHTTPProvider = await zksync.getDefaultProvider("mainnet");
      const accountState = await syncHTTPProvider.getState(address);
      if (!accountState.id) {
        const { data } = await network({
          method: "GET",
          url: `${ethBaseURL}/addresses/${address}/nonce`,
        });
        return data[0].nonce;
      }

      return accountState.committed.nonce;
    },

    async broadcastTransaction(tx) {
      return true
    },

    async getAccountBalance(address) {
      const syncHTTPProvider = await zksync.getDefaultProvider("mainnet");
      const accountState = await syncHTTPProvider.getState(address);
      if (!accountState.id) {
        const { data } = await network({
          method: "GET",
          url: `${ethBaseURL}/addresses/${address}/balance`,
          transformResponse: JSONBigNumber.parse,
        });
        return new BigNumber(data[0].balance);
      }

      return new BigNumber(accountState.committed.balances.ETH);
    },

    async getERC20Balances(_) {
      return [];
    },

    async getERC20ApprovalsPerContract(owner, contract) {
      try {
        const { data } = await network({
          method: "GET",
          url: URL.format({
            pathname: `${rollupBaseURL}/erc20/approvals`,
            query: {
              owner,
              contract,
            },
          }),
        });
        return data
          .map((m: mixed) => {
            if (!m || typeof m !== "object") return;
            const { sender, value } = m;
            if (typeof sender !== "string" || typeof value !== "string") return;
            return { sender, value };
          })
          .filter(Boolean);
      } catch (e) {
        if (e.status === 404) {
          return [];
        }
        throw e;
      }
    },

    async roughlyEstimateGasLimit(address) {
      return defaultGas;
    },

    async getDryRunGasLimit(address, request) {
      return defaultGas;
    },

    getGasTrackerBarometer: makeLRUCache(
      async () => {
        return {
          low: BigNumber(0),
          medium: BigNumber(100),
          high: BigNumber(1000),
        };
      },
      () => "",
      { maxAge: 30 * 1000 }
    ),
  };
};
