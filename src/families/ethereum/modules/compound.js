// @flow

// FIXME there are two tradeoffs and problems to solve
// - first of all, compound api is not that fast and we are not optimized by pulling for each trade
// - secondly, we need to implement the "historical over time" changes.
// IDEA: to me we need to reborn the idea that we will pull daily rates and just stick to it (even if it means some approximation)

import URL from "url";
import { BigNumber } from "bignumber.js";
import values from "lodash/values";
import type {
  TokenAccount,
  CryptoCurrency,
  TokenCurrency,
  OperationType,
} from "../../../types";
import type { ModeModule } from "../types";
import {
  listTokens,
  listTokensForCryptoCurrency,
  getTokenById,
} from "../../../currencies";
import network from "../../../network";
import { promiseAllBatched } from "../../../promise";
import { getEnv } from "../../../env";
import { mergeOps } from "../../../bridge/jsHelpers";

export type Modes =
  | "compound.mint"
  | "compound.redeem"
  | "compound.redeemUnderlying";

export const modes: { [_: Modes]: ModeModule } = {};

// TODO: NB: this needs to be serializable
type CompoundPreloaded = {
  [tokenId: string]: {
    rate: string,
    supplyAPY: string,
  },
};

let compoundPreloadedValue: CompoundPreloaded = {};

// FIXME: if the current rate is needed at global level, we should consider having it in preload() stuff
// NB we might want to preload at each sync too.
// if that's the case we need to see how to implement this in bridge cycle.
// => allow to define strategy to reload preload()

export async function preload(): Promise<CompoundPreloaded> {
  if (!getEnv("COMPOUND")) return Promise.resolve({});
  const ctokens = listTokens({ withDelisted: true }).filter(
    (t) => t.compoundFor
  );
  const currentRates = await fetchCurrentRates(ctokens);
  const preloaded = {};
  currentRates.forEach((r) => {
    preloaded[r.token.id] = {
      rate: r.rate.toString(10),
      supplyAPY: r.supplyAPY,
    };
  });
  compoundPreloadedValue = preloaded;
  return preloaded;
}

export function hydrate(value: CompoundPreloaded) {
  compoundPreloadedValue = value;
}

export function getCTokenRate(ctoken: TokenCurrency) {
  const value = compoundPreloadedValue[ctoken.id];
  return value ? BigNumber(value.rate) : BigNumber(0);
}

export function getCTokenSupplyAPY(ctoken: TokenCurrency) {
  const value = compoundPreloadedValue[ctoken.id];
  return value ? value.supplyAPY : "";
}

export function prepareTokenAccounts(
  currency: CryptoCurrency,
  subAccounts: TokenAccount[]
): TokenAccount[] {
  if (currency.id !== "ethereum" || !getEnv("COMPOUND")) return subAccounts;

  const compoundByTokenId = inferSubAccountsCompound(currency, subAccounts);

  // add implicitly all ctoken account when a token account exists so we can fetch the balance again
  const implicitCTokenAccounts = values(compoundByTokenId)
    .map(({ tokenAccount, ctokenAccount, ctoken }): ?TokenAccount =>
      tokenAccount && !ctokenAccount
        ? // TODO reuse generateTokenAccount
          {
            // this is a placeholder that will be dropped by digestTokenAccounts
            type: "TokenAccount",
            id: "empty_" + ctoken.id,
            token: ctoken,
            parentId: "",
            balance: BigNumber(0),
            spendableBalance: BigNumber(0),
            creationDate: new Date(),
            operationsCount: 0,
            operations: [],
            pendingOperations: [],
            starred: false,
            swapHistory: [],
          }
        : null
    )
    .filter(Boolean);

  if (implicitCTokenAccounts.length === 0) return subAccounts;

  return subAccounts.concat(implicitCTokenAccounts);
}

const cdaiToDaiOpMapping: { [_: OperationType]: ?OperationType } = {
  IN: "SUPPLY",
  OUT: "REDEEM",
};

export async function digestTokenAccounts(
  currency: CryptoCurrency,
  subAccounts: TokenAccount[]
): Promise<TokenAccount[]> {
  if (currency.id !== "ethereum" || !getEnv("COMPOUND")) return subAccounts;

  const compoundByTokenId = inferSubAccountsCompound(currency, subAccounts);
  if (Object.keys(compoundByTokenId).length === 0) return subAccounts;

  // TODO:
  // for each C* tokens when both C* and * exists:
  // - merge the C* ops in * and dedup
  // - fetch rates of the new C* ops that was not yet digested
  // - fetch current rate
  // - make the balance adding up C* and * rates + availableBalance
  // - add extra operation to reflect the C* ones
  // - remove the C*
  const all = await promiseAllBatched(2, subAccounts, async (a) => {
    // C* tokens are digested by the related ERC20 account so they completely disappear for the user
    const { compoundFor } = a.token;
    if (compoundFor) {
      // however, if the related ERC20 account would not exist, we would allow its display
      if (!compoundByTokenId[compoundFor]) {
        return a;
      }
      return;
    }

    const maybeCompound = compoundByTokenId[a.token.id];
    if (maybeCompound) {
      // digest the C* account
      const { ctoken, ctokenAccount } = maybeCompound;
      if (ctokenAccount) {
        // balance = balance + rate * cbalance
        let balance = a.balance;
        let spendableBalance = a.balance;
        const latestRate = getCTokenRate(ctoken);
        balance = balance.plus(
          ctokenAccount.balance.times(latestRate).integerValue()
        );

        // TODO balanceHistory
        /*
        const minBlockTimestamp = 0; // oldest operation in either token/ctoken account
        const maxBlockTimestamp = 0; // today at 00:00
        const numBuckets = 0; // nb of days between two
        const dailyRates = [];
        const balanceHistory = {};
        // (getBalanceHistoryImpl for dai) + dailyRates[i] * (getBalanceHistoryImpl for cdai)
        */

        // operations, C* to * conversions with the historical rates
        // cIN => SUPPLY
        // cOUT => REDEEM
        const rates = await fetchHistoricalRates(
          ctoken,
          ctokenAccount.operations.map((op) => op.date)
        );

        const newOps = ctokenAccount.operations
          .map((op, i) => {
            const { rate } = rates[i];
            const value = op.value.times(rate).integerValue();
            const type = cdaiToDaiOpMapping[op.type];
            if (!type) return;
            return {
              ...op,
              id: `${a.id}-${op.hash}-${type}`,
              type,
              value,
              accountId: a.id,
              extra: { compoundValue: op.value, rate: rate.toString() },
            };
          })
          .filter(Boolean);

        // TODO: for perf, we can be a slightly more conservative and keep refs as much as possible to not have a ref changes above
        return {
          ...a,
          spendableBalance,
          balance,
          operations: mergeOps(a.operations, newOps),
        };
      }
    }
    return a;
  });

  return all.filter(Boolean);
}

const API_BASE = `https://api.compound.finance/api/v2`;

const fetch = (path, query = {}) =>
  network({
    type: "get",
    url: URL.format({
      pathname: `${API_BASE}${path}`,
      query,
    }),
  });

type CurrentRate = {
  token: TokenCurrency,
  rate: BigNumber,
  supplyAPY: string,
};

async function fetchCurrentRates(tokens): Promise<CurrentRate[]> {
  if (tokens.length === 0) return [];
  const { data } = await fetch("/ctoken", {
    block_timestamp: 0,
    addresses: tokens.map((c) => c.contractAddress).join(","),
  });
  return tokens.map((token) => {
    const cToken = data.cToken.find(
      (ct) =>
        ct.token_address.toLowerCase() === token.contractAddress.toLowerCase()
    );
    if (!cToken) return { token, rate: BigNumber("0"), supplyAPY: "" };
    const rawRate = cToken.exchange_rate.value;
    const otoken = getTokenById(token.compoundFor || "");
    const magnitudeRatio = BigNumber(10).pow(
      otoken.units[0].magnitude - token.units[0].magnitude
    );
    const rate = BigNumber(rawRate).times(magnitudeRatio);
    const supplyAPY =
      BigNumber(cToken.comp_supply_apy.value).decimalPlaces(2).toString() + "%";
    const r: CurrentRate = { token, rate, supplyAPY };
    return r;
  });
}

type HistoRate = {
  token: TokenCurrency,
  rate: BigNumber,
};

async function fetchHistoricalRates(
  token,
  dates: Date[]
): Promise<HistoRate[]> {
  const all = await promiseAllBatched(3, dates, async (date) => {
    const { data } = await fetch("/ctoken", {
      block_timestamp: Math.round(date.getTime() / 1000),
      addresses: [token.contractAddress],
    });
    const cToken = data.cToken.find(
      (ct) =>
        ct.token_address.toLowerCase() === token.contractAddress.toLowerCase()
    );
    if (!cToken) return { token, rate: BigNumber("0") };
    const rawRate = cToken.exchange_rate.value;
    const otoken = getTokenById(token.compoundFor || "");
    const magnitudeRatio = BigNumber(10).pow(
      otoken.units[0].magnitude - token.units[0].magnitude
    );
    const rate = BigNumber(rawRate).times(magnitudeRatio);
    return {
      token,
      rate,
    };
  });
  return all;
}

function inferSubAccountsCompound(currency, subAccounts) {
  const compoundByTokenId: {
    [_: string]: ?{
      tokenAccount: ?TokenAccount,
      token: TokenCurrency,
      ctoken: TokenCurrency,
      ctokenAccount: ?TokenAccount,
    },
  } = {};
  listTokensForCryptoCurrency(currency, { withDelisted: true }).forEach(
    (ctoken) => {
      const { compoundFor } = ctoken;
      if (compoundFor) {
        const tokenAccount = subAccounts.find(
          (a) => a.token.id === compoundFor
        );
        const ctokenAccount = subAccounts.find((a) => a.token === ctoken);
        if (!tokenAccount && !ctokenAccount) return;
        const token = getTokenById(compoundFor);
        compoundByTokenId[compoundFor] = {
          tokenAccount,
          token,
          ctoken,
          ctokenAccount,
        };
      }
    }
  );
  return compoundByTokenId;
}
